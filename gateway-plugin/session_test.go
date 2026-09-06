package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixtureTransport(t *testing.T) *int {
	t.Helper()
	old := loginTransport
	posts := 0
	loginTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		h := http.Header{}
		body := ""
		status := 200
		switch {
		case r.Method == "GET" && r.URL.String() == formURL:
			h.Add("Set-Cookie", "JSESSIONID=fixture-session; Path=/online; Secure; HttpOnly")
			body = `<form id="loginForm" method="post" action="/online/he/j_spring_security_check"><input type="hidden" name="CSRFToken" value="fresh-csrf"></form>`
		case r.Method == "POST" && r.URL.String() == loginURL:
			posts++
			r.ParseForm()
			cookie, e := r.Cookie("JSESSIONID")
			if e != nil || cookie.Value != "fixture-session" || r.Form.Get("CSRFToken") != "fresh-csrf" {
				t.Error("login lost the gateway-held session/CSRF pair")
			}
			if r.Form.Get("j_username") != "fixture+shopping@example.invalid" || r.Form.Get("j_password") != "fixture only +&=% password" {
				t.Error("login pair not filled")
			}
			if r.Form.Has("remember-me") {
				t.Error("persistent login enabled")
			}
			h.Add("Set-Cookie", "JSESSIONID=authenticated-session; Path=/online; Secure; HttpOnly")
			h.Set("Location", homeURL)
			status = 302
		case r.Method == "GET" && r.URL.String() == homeURL:
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	t.Cleanup(func() {
		loginTransport = old
		sessions.Lock()
		sessions.cookies = map[string]string{}
		sessions.Unlock()
	})
	return &posts
}
func TestSessionOwnsCookiesAndUsesFreshCSRF(t *testing.T) {
	posts := fixtureTransport(t)
	c, e := establishSession(context.Background(), "fixture", "fixture+shopping@example.invalid", "fixture only +&=% password", "fixture-agent")
	if e != nil || !strings.Contains(c, "authenticated-session") || *posts != 1 {
		t.Fatalf("session flow failed: %v", e)
	}
	if sessionCookie("other") != "" {
		t.Fatal("credential instance isolation failed")
	}
}
func TestSessionRejectsChangedFormBeforePosting(t *testing.T) {
	posts := fixtureTransport(t)
	original := loginTransport
	loginTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		resp, e := original.RoundTrip(r)
		if r.Method == "GET" {
			resp.Body = io.NopCloser(strings.NewReader(`<form id="loginForm" method="post" action="https://evil.invalid"><input name="CSRFToken" value="x"></form>`))
		}
		return resp, e
	})
	_, e := establishSession(context.Background(), "fixture", "fixture", "fixture", "fixture-agent")
	if e == nil || *posts != 0 {
		t.Fatal("changed form did not fail before posting")
	}
}

func TestSessionRejectsCrossOriginRedirectWithoutFollowing(t *testing.T) {
	posts := fixtureTransport(t)
	original := loginTransport
	loginTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		resp, e := original.RoundTrip(r)
		if r.Method == "POST" {
			resp.Header.Set("Location", "https://evil.invalid/collect")
		}
		return resp, e
	})
	_, e := establishSession(context.Background(), "fixture", "fixture+shopping@example.invalid", "fixture only +&=% password", "fixture-agent")
	if e == nil || *posts != 1 || sessionCookie("fixture") != "" {
		t.Fatal("unsafe redirect did not fail closed")
	}
}
