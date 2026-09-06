package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/denoland/clawpatrol/pluginsdk"
)

const couponPath = "/online/he/my-account/coupons/activate-coupon"
const couponMarker = "Bearer PH_shufersal_coupon"

var couponCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func transformCoupon(req pluginsdk.HTTPTransformRequest, target *url.URL) (*pluginsdk.HTTPTransformResponse, error) {
	deny := errors.New("shufersal coupon activation denied")
	if target.Scheme != "https" || target.Host != "www.shufersal.co.il" || target.User != nil || target.Fragment != "" || target.RawQuery != "" || target.Path != couponPath || req.Host != "www.shufersal.co.il" || req.Method != http.MethodPost || len(req.Headers.Values("Authorization")) != 1 || req.Headers.Get("Authorization") != couponMarker || req.Headers.Get("Content-Encoding") != "" || req.Body == nil {
		return nil, deny
	}
	csrf := req.Headers.Values("CSRFToken")
	if len(csrf) != 1 || len(csrf[0]) == 0 || len(csrf[0]) > 256 {
		return nil, deny
	}
	media, params, err := mime.ParseMediaType(req.Headers.Get("Content-Type"))
	if err != nil || media != "application/json" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "UTF-8")) {
		return nil, deny
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, 1025))
	if err != nil || len(body) > 1024 {
		return nil, deny
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || len(fields) != 1 {
		return nil, deny
	}
	var code string
	if json.Unmarshal(fields["couponCode"], &code) != nil || !couponCodePattern.MatchString(code) {
		return nil, deny
	}
	cookie := sessionCookie(req.CredentialInstance)
	if cookie == "" {
		return nil, deny
	}
	// Canonicalize before forwarding so duplicate fields cannot be interpreted differently upstream.
	body, _ = json.Marshal(map[string]string{"couponCode": code})
	return &pluginsdk.HTTPTransformResponse{Body: bytes.NewReader(body), Headers: []pluginsdk.HeaderMutation{
		{Op: pluginsdk.HeaderDel, Name: "Authorization"},
		{Op: pluginsdk.HeaderSet, Name: "Cookie", Values: []string{cookie}},
		{Op: pluginsdk.HeaderSet, Name: "Content-Length", Values: []string{strconv.Itoa(len(body))}},
	}, Redactions: []string{cookie, code}}, nil
}
