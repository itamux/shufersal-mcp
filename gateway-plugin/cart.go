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

const cartMarker = "Bearer PH_shufersal_cart"

var productCode = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// Only item additions and quantity changes are admitted. Zero removes one item;
// clear-cart, checkout, order editing, delivery and payment requests stay denied.
func transformCart(req pluginsdk.HTTPTransformRequest, target *url.URL) (*pluginsdk.HTTPTransformResponse, error) {
	deny := errors.New("shufersal cart request denied")
	if target.Scheme != "https" || target.Host != "www.shufersal.co.il" || target.User != nil || target.Fragment != "" ||
		req.Host != "www.shufersal.co.il" || req.Method != http.MethodPost ||
		len(req.Headers.Values("Authorization")) != 1 || req.Headers.Get("Authorization") != cartMarker ||
		req.Headers.Get("Content-Encoding") != "" || req.Body == nil {
		return nil, deny
	}
	csrf := req.Headers.Values("CSRFToken")
	if len(csrf) != 1 || len(csrf[0]) == 0 || len(csrf[0]) > 256 {
		return nil, deny
	}
	media, params, err := mime.ParseMediaType(req.Headers.Get("Content-Type"))
	if err != nil || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "UTF-8")) {
		return nil, deny
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, 4097))
	if err != nil || len(body) > 4096 {
		return nil, deny
	}
	validQuantity := func(q float64, method string) bool {
		return q >= 0 && q <= 1000 && (method == "BY_WEIGHT" || (method == "BY_UNIT" && q == float64(int(q))))
	}
	switch target.Path {
	case "/online/he/cart/add":
		if target.RawQuery != "" || media != "application/json" {
			return nil, deny
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil || len(fields) != 7 {
			return nil, deny
		}
		var add struct {
			ProductCodePost string  `json:"productCodePost"`
			ProductCode     string  `json:"productCode"`
			SellingMethod   string  `json:"sellingMethod"`
			Qty             float64 `json:"qty"`
			FrontQuantity   float64 `json:"frontQuantity"`
			Comment         string  `json:"comment"`
			AffiliateCode   string  `json:"affiliateCode"`
		}
		// Seven known fields; JSON decoding above also rejects trailing data.
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if dec.Decode(&add) != nil || !productCode.MatchString(add.ProductCode) || add.ProductCodePost != add.ProductCode || add.Qty <= 0 || !validQuantity(add.Qty, add.SellingMethod) || add.FrontQuantity != add.Qty || add.Comment != "" || add.AffiliateCode != "" {
			return nil, deny
		}
		// Re-encode accepted data so ambiguous duplicate-key input is never forwarded.
		body, _ = json.Marshal(add)
	case "/online/he/cart/update":
		if media != "application/x-www-form-urlencoded" {
			return nil, deny
		}
		query, e := url.ParseQuery(target.RawQuery)
		if e != nil || len(query) != 3 {
			return nil, deny
		}
		for _, k := range []string{"entryNumber", "qty", "sellingMethod"} {
			if len(query[k]) != 1 {
				return nil, deny
			}
		}
		entry, e := strconv.Atoi(query.Get("entryNumber"))
		if e != nil || entry < 0 || entry > 1000000 {
			return nil, deny
		}
		qty, e := strconv.ParseFloat(query.Get("qty"), 64)
		if e != nil || !validQuantity(qty, query.Get("sellingMethod")) {
			return nil, deny
		}
		form, e := url.ParseQuery(string(body))
		if e != nil || len(form) != 1 || len(form["quantity"]) != 1 || form.Get("quantity") != query.Get("qty") {
			return nil, deny
		}
	default:
		return nil, deny
	}
	cookie := sessionCookie(req.CredentialInstance)
	if cookie == "" {
		return nil, errors.New("shufersal login required before cart changes")
	}
	return &pluginsdk.HTTPTransformResponse{Body: bytes.NewReader(body), Headers: []pluginsdk.HeaderMutation{
		{Op: pluginsdk.HeaderDel, Name: "Authorization"},
		{Op: pluginsdk.HeaderSet, Name: "Cookie", Values: []string{cookie}},
		{Op: pluginsdk.HeaderSet, Name: "Content-Length", Values: []string{strconv.Itoa(len(body))}},
	}, Redactions: []string{cookie}}, nil
}
