package docker

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// DockerClient wraps HTTP communication with the Docker Engine API.
type DockerClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewDockerClient creates a DockerClient from the given config.
// Unix socket mode uses a custom dialer; TCP mode uses a standard client
// (optionally with TLS when config.TLS is true).
func NewDockerClient(config DockerConfig) (*DockerClient, error) {
	var transport http.RoundTripper

	if config.SocketPath != "" {
		// Unix socket mode
		dialer := &net.Dialer{}
		transport = &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", config.SocketPath)
			},
		}
	} else {
		// TCP mode
		host := config.Host
		if host == "" {
			host = "localhost"
		}
		port := config.Port
		if port == 0 {
			port = 2375
		}
		_ = fmt.Sprintf("%s:%d", host, port) // validated implicitly by HTTP calls

		var tlsConfig *tls.Config
		if config.TLS {
			var err error
			tlsConfig, err = buildTLSConfig(config)
			if err != nil {
				return nil, fmt.Errorf("TLS config error: %w", err)
			}
		}
		transport = &http.Transport{
			TLSClientConfig: tlsConfig,
		}
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   120 * time.Second,
	}

	var baseURL string
	if config.SocketPath != "" {
		baseURL = "http://unixsocket/v1.43"
	} else {
		host := config.Host
		if host == "" {
			host = "localhost"
		}
		port := config.Port
		if port == 0 {
			port = 2375
		}
		scheme := "http"
		if config.TLS {
			scheme = "https"
		}
		baseURL = fmt.Sprintf("%s://%s:%d/v1.43", scheme, host, port)
	}

	return &DockerClient{
		baseURL:    baseURL,
		httpClient: client,
	}, nil
}

// Get performs a GET request and decodes the JSON response into result.
func (c *DockerClient) Get(path string, result interface{}) error {
	url := c.baseURL + path
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GET %s returned %d: %s", path, resp.StatusCode, string(body))
	}

	if result != nil {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("GET %s decode error: %w", path, err)
		}
	}
	return nil
}

// Post performs a POST request with a JSON body and decodes the response into result.
func (c *DockerClient) Post(path string, body interface{}, result interface{}) error {
	url := c.baseURL + path

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("POST %s marshal error: %w", path, err)
		}
		bodyReader = bytes.NewReader(data)
	}

	resp, err := c.httpClient.Post(url, "application/json", bodyReader)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("POST %s returned %d: %s", path, resp.StatusCode, string(bodyBytes))
	}

	if result != nil {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("POST %s decode error: %w", path, err)
		}
	}
	return nil
}

// Delete performs a DELETE request.
func (c *DockerClient) Delete(path string) error {
	url := c.baseURL + path
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return fmt.Errorf("DELETE %s request creation error: %w", path, err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("DELETE %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("DELETE %s returned %d: %s", path, resp.StatusCode, string(body))
	}
	return nil
}

// PostStream performs a POST request and returns the raw response body for streaming.
// The caller is responsible for closing the returned ReadCloser.
func (c *DockerClient) PostStream(path string, body interface{}) (io.ReadCloser, error) {
	url := c.baseURL + path

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("POST(stream) %s marshal error: %w", path, err)
		}
		bodyReader = bytes.NewReader(data)
	}

	resp, err := c.httpClient.Post(url, "application/json", bodyReader)
	if err != nil {
		return nil, fmt.Errorf("POST(stream) %s: %w", path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("POST(stream) %s returned %d: %s", path, resp.StatusCode, string(bodyBytes))
	}

	return resp.Body, nil
}

// buildTLSConfig constructs a *tls.Config from base64-encoded CA/Cert/Key materials.
func buildTLSConfig(config DockerConfig) (*tls.Config, error) {
	tlsConfig := &tls.Config{}

	if config.CACert != "" {
		caPEM, err := base64.StdEncoding.DecodeString(config.CACert)
		if err != nil {
			return nil, fmt.Errorf("decode CA cert: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("failed to append CA cert")
		}
		tlsConfig.RootCAs = pool
	}

	if config.Cert != "" && config.Key != "" {
		certPEM, err := base64.StdEncoding.DecodeString(config.Cert)
		if err != nil {
			return nil, fmt.Errorf("decode cert: %w", err)
		}
		keyPEM, err := base64.StdEncoding.DecodeString(config.Key)
		if err != nil {
			return nil, fmt.Errorf("decode key: %w", err)
		}
		cert, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			return nil, fmt.Errorf("load key pair: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	}

	return tlsConfig, nil
}
