package main

import "github.com/denoland/clawpatrol/pluginsdk"

func main() {
	pluginsdk.Run(&pluginsdk.Plugin{
		Name: "shufersal_login", Version: "0.4.1",
		Capabilities: pluginsdk.Capabilities{Network: pluginsdk.NetworkOutbound},
		Credentials:  []pluginsdk.CredentialDef{loginDef()},
	})
}
