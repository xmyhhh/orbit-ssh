// Package platform provides the services the application needs from the
// operating system, such as the configuration directory, the credential vault
// and the native dialogs.
//
// The desktop and the mobile build use different implementations, so the rest
// of the code only deals with the functions below.
package platform

// Service is the name the credentials are stored under.
const Service = "OrbitSSH"
