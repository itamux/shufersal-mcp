package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/denoland/clawpatrol/pluginsdk"
)

const loginURL = "https://www.shufersal.co.il/online/he/j_spring_security_check"
const marker = "Bearer PH_shufersal_login"
const emailPlaceholder = "PH_shufersal_email"
const passwordPlaceholder = "PH_shufersal_password"

func loginDef() pluginsdk.CredentialDef {
	return pluginsdk.CredentialDef{
		TypeName: "shufersal_login", Disambiguators: []string{"placeholder"}, HTTPTransform: true,
		Build: func(pluginsdk.BuildRequest) (any, error) {
			return pluginsdk.CredentialBuildResult{
				Canonical: struct{}{},
				Metadata: pluginsdk.CredentialMetadata{
					HTTPTransform: true,
					SecretSlots: []pluginsdk.SecretSlot{
						{Label: "Shufersal login", Description: "Email/password pair assembled in gateway memory from the two Infisical entries."},
					},
					EnvVars: []pluginsdk.EnvVar{
						{Name: "SHUFERSAL_EMAIL", Value: emailPlaceholder},
						{Name: "SHUFERSAL_PASSWORD", Value: passwordPlaceholder},
					},
				},
			}, nil
		},
		TransformHTTP: transformLogin,
	}
}

// The plugin owns the upstream login session. Neither the MCP process nor
// the model receives credentials or session cookies.
func transformLogin(ctx context.Context, req pluginsdk.HTTPTransformRequest) (*pluginsdk.HTTPTransformResponse, error) {
	// A singleton credential can be selected for public page/resource reads too.
	// Those must pass without injecting secrets; other writes still fail closed.
	target, parseErr := url.Parse(req.URL)
	if parseErr == nil && req.Method == http.MethodPost && target.Path == couponPath {
		return transformCoupon(req, target)
	}
	if parseErr == nil && req.Method == http.MethodPost && strings.HasPrefix(target.Path, "/online/he/cart/") {
		return transformCart(req, target)
	}
	if parseErr == nil && target.Scheme == "https" && target.Host == "www.shufersal.co.il" &&
		target.User == nil && req.Host == "www.shufersal.co.il" &&
		(req.Method == http.MethodGet || req.Method == http.MethodHead) &&
		!strings.Contains(strings.ToLower(target.Path), "logout") &&
		!strings.Contains(strings.ToLower(target.Path), "checkout") &&
		(!strings.Contains(target.Path, "/cart/") || (target.Path == "/online/he/cart/load" && (target.RawQuery == "" || (req.Method == http.MethodGet && target.RawQuery == "restoreCart=true")))) && len(req.Headers.Values("Authorization")) == 0 {
		cookie := sessionCookie(req.CredentialInstance)
		out := &pluginsdk.HTTPTransformResponse{Body: req.Body, Headers: []pluginsdk.HeaderMutation{{Op: pluginsdk.HeaderDel, Name: "Cookie"}}}
		if cookie != "" {
			out.Headers = append(out.Headers, pluginsdk.HeaderMutation{Op: pluginsdk.HeaderSet, Name: "Cookie", Values: []string{cookie}})
			out.Redactions = []string{cookie}
		}
		return out, nil
	}
	if req.Method != http.MethodPost || req.URL != loginURL || req.Host != "www.shufersal.co.il" {
		return nil, errors.New("shufersal_login target denied")
	}
	if values := req.Headers.Values("Authorization"); len(values) != 1 || values[0] != marker {
		return nil, errors.New("shufersal_login marker required")
	}
	media, params, err := mime.ParseMediaType(req.Headers.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || len(params) > 1 ||
		(len(params) == 1 && !strings.EqualFold(params["charset"], "UTF-8")) || req.Headers.Get("Content-Encoding") != "" {
		return nil, errors.New("shufersal_login form encoding denied")
	}
	if req.Body == nil {
		return nil, errors.New("shufersal_login form required")
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, 16385))
	if err != nil || len(body) > 16384 {
		return nil, errors.New("shufersal_login form unreadable or oversized")
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, errors.New("shufersal_login invalid form")
	}
	for key, values := range form {
		if len(values) != 1 || (key != "j_username" && key != "j_password" && key != "CSRFToken" && key != "fail_url") {
			return nil, errors.New("shufersal_login form fields denied")
		}
	}
	if form.Get("j_username") != emailPlaceholder || form.Get("j_password") != passwordPlaceholder ||
		form.Get("CSRFToken") == "" || (form.Has("fail_url") && form.Get("fail_url") != "/login/?error=true") {
		return nil, errors.New("shufersal_login placeholders or CSRF missing")
	}
	var pair struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if json.Unmarshal(req.CredentialSecret, &pair) != nil {
		return nil, errors.New("shufersal_login gateway credential pair invalid")
	}
	email, password := pair.Email, pair.Password
	if email == "" || password == "" || len(email) > 320 || len(password) > 4096 ||
		!strings.Contains(email, "@") || strings.ContainsAny(email+password, "\r\n\x00") ||
		email == emailPlaceholder || password == passwordPlaceholder {
		return nil, errors.New("shufersal_login gateway credential slots invalid")
	}
	cookie, err := establishSession(ctx, req.CredentialInstance, email, password, req.Headers.Get("User-Agent"))
	if err != nil {
		return nil, err
	}
	// The gateway owns the cookie jar and performs the one actual login POST.
	// Forward a fresh homepage GET so Chromium receives authenticated HTML
	// without ever receiving the session cookie or the real password.
	return &pluginsdk.HTTPTransformResponse{
		Method: "GET", URL: homeURL,
		Headers: []pluginsdk.HeaderMutation{
			{Op: pluginsdk.HeaderDel, Name: "Authorization"},
			{Op: pluginsdk.HeaderDel, Name: "Content-Type"},
			{Op: pluginsdk.HeaderSet, Name: "Content-Length", Values: []string{"0"}},
			{Op: pluginsdk.HeaderSet, Name: "Cookie", Values: []string{cookie}},
		},
		Redactions: []string{email, password, url.QueryEscape(email), url.QueryEscape(password), cookie},
	}, nil
}
