package main

import (
	"context"
	"github.com/denoland/clawpatrol/pluginsdk"
	"io"
	"strings"
	"testing"
)

func couponFixture(t *testing.T) pluginsdk.HTTPTransformRequest {
	r := cartFixture(t)
	r.URL = homeURL + "my-account/coupons/activate-coupon"
	r.Headers.Set("Authorization", couponMarker)
	r.Body = strings.NewReader(`{"couponCode":"12345678"}`)
	return r
}
func TestCouponActivationCustody(t *testing.T) {
	r := couponFixture(t)
	out, err := transformLogin(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(out.Body)
	if string(b) != `{"couponCode":"12345678"}` || len(out.Redactions) != 2 || out.Headers[0].Name != "Authorization" {
		t.Fatal("missing canonical request and redactions")
	}
}
func TestCouponActivationRejectsOtherEffects(t *testing.T) {
	cases := map[string]func(*pluginsdk.HTTPTransformRequest){
		"wrong marker": func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Set("Authorization", cartMarker) },
		"no CSRF":      func(r *pluginsdk.HTTPTransformRequest) { r.Headers.Del("CSRFToken") },
		"no session":   func(r *pluginsdk.HTTPTransformRequest) { r.CredentialInstance = "absent" },
		"external":     func(r *pluginsdk.HTTPTransformRequest) { r.URL = "https://evil.invalid" + couponPath },
		"query":        func(r *pluginsdk.HTTPTransformRequest) { r.URL += "?redeem=true" },
		"redemption":   func(r *pluginsdk.HTTPTransformRequest) { r.URL = homeURL + "my-account/coupons/redeem" },
		"extra field": func(r *pluginsdk.HTTPTransformRequest) {
			r.Body = strings.NewReader(`{"couponCode":"123","redeem":true}`)
		},
		"array": func(r *pluginsdk.HTTPTransformRequest) { r.Body = strings.NewReader(`{"couponCode":["123","456"]}`) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			r := couponFixture(t)
			change(&r)
			if _, err := transformLogin(context.Background(), r); err == nil {
				t.Fatal("accepted unsafe request")
			}
		})
	}
}
