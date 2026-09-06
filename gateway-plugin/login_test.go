package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/denoland/clawpatrol/pluginsdk"
)

func fixture() pluginsdk.HTTPTransformRequest {
	return pluginsdk.HTTPTransformRequest{
		Method: "POST", URL: loginURL, Host: "www.shufersal.co.il",
		Headers:          http.Header{"Authorization": {marker}, "Content-Type": {"application/x-www-form-urlencoded"}},
		Body:             strings.NewReader("j_username=PH_shufersal_email&j_password=PH_shufersal_password&CSRFToken=fixture&fail_url=%2Flogin%2F%3Ferror%3Dtrue"),
		CredentialSecret: []byte(`{"email":"fixture+shopping@example.invalid","password":"fixture only +&=% password"}`),
	}
}

func TestInjectsOnlyTheTwoFields(t *testing.T) {
	fixtureTransport(t)
	r, err := transformLogin(context.Background(), fixture())
	if err != nil {
		t.Fatal(err)
	}
	if r.Method != "GET" || r.URL != homeURL || r.Body != nil {
		t.Fatal("login must become a fresh home GET")
	}
	if len(r.Redactions) != 5 || r.Headers[0].Name != "Authorization" {
		t.Fatal("missing secret/cookie redaction")
	}

}

func TestPublicReadNeedsNoSecretSlots(t *testing.T) {
	r := pluginsdk.HTTPTransformRequest{Method: "GET", URL: "https://www.shufersal.co.il/online/he/", Host: "www.shufersal.co.il", Headers: http.Header{}}
	out, err := transformLogin(context.Background(), r)
	if err != nil || len(out.Headers) != 1 || len(out.Redactions) != 0 {
		t.Fatal("public read should pass without injection")
	}
}

func TestRejectsUnsafeRequests(t *testing.T) {
	cases := map[string]func(*pluginsdk.HTTPTransformRequest){
		"other host": func(r *pluginsdk.HTTPTransformRequest) { r.Host = "evil.invalid" },
		"lookalike URL": func(r *pluginsdk.HTTPTransformRequest) {
			r.URL = strings.Replace(loginURL, ".co.il", ".co.il.evil.invalid", 1)
		},
		"other path":       func(r *pluginsdk.HTTPTransformRequest) { r.URL = "https://www.shufersal.co.il/cart/add" },
		"query":            func(r *pluginsdk.HTTPTransformRequest) { r.URL += "?next=https://evil.invalid" },
		"GET":              func(r *pluginsdk.HTTPTransformRequest) { r.Method = "GET" },
		"no marker":        func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Del("Authorization") },
		"duplicate marker": func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Add("Authorization", marker) },
		"JSON":             func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Set("Content-Type", "application/json") },
		"compressed":       func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Set("Content-Encoding", "gzip") },
		"oversized":        func(r *pluginsdk.HTTPTransformRequest) { r.Body = strings.NewReader(strings.Repeat("x", 16385)) },
		"missing password": func(r *pluginsdk.HTTPTransformRequest) { r.CredentialSecret = nil },
		"missing email":    func(r *pluginsdk.HTTPTransformRequest) { r.CredentialSecret = []byte(`{"password":"fixture"}`) },
		"duplicate field": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = io.MultiReader(r.Body, strings.NewReader("&j_username=other"))
		},
		"redirect field": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = io.MultiReader(r.Body, strings.NewReader("&redirect=https://evil.invalid"))
		},
		"remember me": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = io.MultiReader(r.Body, strings.NewReader("&remember-me=true"))
		},
		"real consumer value": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = strings.NewReader("j_username=fixture@example.invalid&j_password=PH_shufersal_password&CSRFToken=fixture")
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := fixture()
			mutate(&r)
			out, err := transformLogin(context.Background(), r)
			if err == nil || out != nil {
				t.Fatal("unsafe request accepted")
			}
			if strings.Contains(err.Error(), "fixture only") || strings.Contains(err.Error(), "fixture+shopping") {
				t.Fatal("credential in error")
			}
		})
	}
}
