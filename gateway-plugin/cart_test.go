package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/denoland/clawpatrol/pluginsdk"
)

func cartFixture(t *testing.T) pluginsdk.HTTPTransformRequest {
	t.Helper()
	sessions.Lock()
	sessions.cookies["cart-fixture"] = "JSESSIONID=fixture-session"
	sessions.Unlock()
	t.Cleanup(func() { sessions.Lock(); delete(sessions.cookies, "cart-fixture"); sessions.Unlock() })
	return pluginsdk.HTTPTransformRequest{Method: "POST", URL: homeURL + "cart/add", Host: "www.shufersal.co.il", CredentialInstance: "cart-fixture",
		Headers: http.Header{"Authorization": {cartMarker}, "Content-Type": {"application/json"}, "Csrftoken": {"fixture"}},
		Body:    strings.NewReader(`{"productCodePost":"P_123","productCode":"P_123","sellingMethod":"BY_UNIT","qty":1,"frontQuantity":1,"comment":"","affiliateCode":""}`)}
}
func TestCartInjectsSessionWithoutCredentials(t *testing.T) {
	req := cartFixture(t)
	out, e := transformLogin(context.Background(), req)
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(out.Body)
	if !strings.Contains(string(body), `"qty":1`) || out.Headers[0].Op != pluginsdk.HeaderDel || out.Headers[1].Name != "Cookie" || len(out.Redactions) != 1 {
		t.Fatal("missing canonical body/session custody")
	}
}
func TestCartQuantityUpdateAndSingleRemoval(t *testing.T) {
	for _, qty := range []string{"2", "0"} {
		r := cartFixture(t)
		r.URL = homeURL + "cart/update?entryNumber=0&qty=" + qty + "&sellingMethod=BY_UNIT"
		r.Headers.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
		r.Body = strings.NewReader("quantity=" + qty)
		if _, e := transformLogin(context.Background(), r); e != nil {
			t.Fatal(e)
		}
	}
}
func TestCartRejectsUnsafeRequests(t *testing.T) {
	cases := map[string]func(*pluginsdk.HTTPTransformRequest){
		"checkout":   func(r *pluginsdk.HTTPTransformRequest) { r.URL = homeURL + "checkout" },
		"clear cart": func(r *pluginsdk.HTTPTransformRequest) { r.URL = homeURL + "cart/remove" },
		"order editing": func(r *pluginsdk.HTTPTransformRequest) {
			r.Method = "GET"
			r.Headers.Del("Authorization")
			r.URL = homeURL + "cart/cartFromOrder/123"
		},
		"cart restore GET": func(r *pluginsdk.HTTPTransformRequest) {
			r.Method = "GET"
			r.Headers.Del("Authorization")
			r.URL = homeURL + "cart/load?restoreCart=true"
		},
		"external":     func(r *pluginsdk.HTTPTransformRequest) { r.URL = "https://evil.invalid/online/he/cart/add" },
		"login marker": func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Set("Authorization", marker) },
		"missing CSRF": func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Del("CSRFToken") },
		"no session":   func(r *pluginsdk.HTTPTransformRequest) { r.CredentialInstance = "absent" },
		"extra field": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = strings.NewReader(`{"productCodePost":"P_123","productCode":"P_123","sellingMethod":"BY_UNIT","qty":1,"frontQuantity":1,"comment":"","affiliateCode":"","executeTransaction":true}`)
		},
		"quantity mismatch": func(r *pluginsdk.HTTPTransformRequest) {
			r.URL = homeURL + "cart/update?entryNumber=0&qty=2&sellingMethod=BY_UNIT"
			r.Headers.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Body = strings.NewReader("quantity=3")
		},
		"NaN": func(r *pluginsdk.HTTPTransformRequest) {
			r.URL = homeURL + "cart/update?entryNumber=0&qty=NaN&sellingMethod=BY_UNIT"
			r.Headers.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Body = strings.NewReader("quantity=NaN")
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			r := cartFixture(t)
			change(&r)
			if out, e := transformLogin(context.Background(), r); e == nil || out != nil {
				t.Fatal("unsafe request accepted")
			}
		})
	}
}
