package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
)

const homeURL = "https://www.shufersal.co.il/online/he/"
const formURL = "https://www.shufersal.co.il/online/he/login"

// Cookies never leave the gateway plugin except as upstream request headers.
// No disk jar, browser cookie export, or credentials in consumer configuration.
var sessions = struct {
	sync.Mutex
	cookies map[string]string
}{cookies: make(map[string]string)}
var loginTransport http.RoundTripper = newLoginTransport()

func newLoginTransport() *http.Transport {
	// Seatbelt allows the system PEM bundle, but macOS SecPolicyCreateSSL
	// fails inside the plugin sandbox. Use trusted roots without that API.
	roots := x509.NewCertPool()
	loaded := false
	for _, path := range []string{"/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"} {
		if pem, err := os.ReadFile(path); err == nil && roots.AppendCertsFromPEM(pem) {
			loaded = true
		}
	}
	if !loaded {
		roots = nil // Fall back to platform verification; never skip verification.
	}
	return &http.Transport{
		Proxy: nil, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
	}
}

func sessionCookie(instance string) string {
	sessions.Lock()
	defer sessions.Unlock()
	return sessions.cookies[instance]
}

func establishSession(ctx context.Context, instance, email, password, userAgent string) (string, error) {
	sessions.Lock()
	defer sessions.Unlock()
	delete(sessions.cookies, instance)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Transport: loginTransport, Timeout: 30 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 || r.URL.Scheme != "https" || r.URL.Host != "www.shufersal.co.il" || r.URL.User != nil || r.Method != "GET" || strings.Contains(strings.ToLower(r.URL.Path), "logout") {
			return errors.New("login redirect denied")
		}
		return nil
	}}
	fetch := func(method, target string, body io.Reader) (*http.Response, error) {
		r, e := http.NewRequestWithContext(ctx, method, target, body)
		if e != nil {
			return nil, e
		}
		r.Header.Set("User-Agent", userAgent)
		if method == "POST" {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Header.Set("Origin", "https://www.shufersal.co.il")
			r.Header.Set("Referer", formURL)
		}
		return client.Do(r)
	}
	resp, err := fetch("GET", formURL, nil)
	if err != nil {
		return "", errors.New("login session page unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024+1))
	resp.Body.Close()
	if err != nil || len(data) > 2*1024*1024 || resp.StatusCode != 200 {
		return "", errors.New("login session page rejected")
	}
	csrf, err := loginCSRF(string(data))
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(loginURL)
	if len(jar.Cookies(u)) == 0 {
		return "", errors.New("login session cookie missing")
	}
	form := url.Values{"j_username": {email}, "j_password": {password}, "CSRFToken": {csrf}, "fail_url": {"/login/?error=true"}}
	resp, err = fetch("POST", loginURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", errors.New("login session submission failed")
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 2*1024*1024))
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Request.URL.Query().Get("error") == "true" {
		return "", errors.New("login session not accepted")
	}
	cookies := jar.Cookies(u)
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	result := strings.Join(parts, "; ")
	if result == "" {
		return "", errors.New("login session cookie missing")
	}
	sessions.cookies[instance] = result
	return result, nil
}

func loginCSRF(page string) (string, error) {
	z := html.NewTokenizer(strings.NewReader(page))
	inside := false
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		t := z.Token()
		attrs := map[string]string{}
		for _, a := range t.Attr {
			attrs[a.Key] = a.Val
		}
		if tt == html.StartTagToken && t.Data == "form" {
			inside = attrs["id"] == "loginForm"
			if inside && (attrs["action"] != "/online/he/j_spring_security_check" || strings.ToLower(attrs["method"]) != "post") {
				return "", errors.New("login session form changed")
			}
		}
		if tt == html.EndTagToken && t.Data == "form" {
			inside = false
		}
		if inside && (tt == html.StartTagToken || tt == html.SelfClosingTagToken) && t.Data == "input" && attrs["name"] == "CSRFToken" && attrs["value"] != "" {
			return attrs["value"], nil
		}
	}
	return "", errors.New("login session CSRF missing")
}
