package remote

import (
	"net/http"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

type Server struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	Password  string `json:"password"`
	Connected bool   `json:"connected"`
	client    *ssh.Client
	mu        sync.RWMutex
}

type Manager struct {
	servers map[string]*Server
	mu      sync.RWMutex
}

var Mgr = &Manager{servers: make(map[string]*Server)}

func (m *Manager) Connect(srv *Server) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	config := &ssh.ClientConfig{
		User: srv.User,
		Auth: []ssh.AuthMethod{ssh.Password(srv.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout: 10 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", srv.Host, srv.Port)
	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return fmt.Errorf("SSH连接失败: %v", err)
	}

	srv.client = client
	srv.Connected = true
	m.servers[srv.ID] = srv
	return nil
}

func (m *Manager) Disconnect(srv *Server) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if srv.client != nil {
		srv.client.Close()
	}
	srv.client = nil
	srv.Connected = false
	delete(m.servers, srv.ID)
}

func (m *Manager) GetServer(id string) *Server {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.servers[id]
}

func (m *Manager) IsConnected(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	srv := m.servers[id]
	return srv != nil && srv.Connected
}

func (srv *Server) run(cmd string) (string, error) {
	srv.mu.RLock()
	defer srv.mu.RUnlock()
	if srv.client == nil {
		return "", fmt.Errorf("未连接")
	}
	session, err := srv.client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	out, err := session.CombinedOutput(cmd)
	return string(out), err
}

func (srv *Server) Exec(cmd string) (string, error) {
	return srv.run(cmd)
}

// Upload uploads a file to the remote server
func (srv *Server) Upload(remotePath string, content []byte) error {
	srv.mu.RLock()
	defer srv.mu.RUnlock()
	if srv.client == nil {
		return fmt.Errorf("未连接")
	}
	
	// Use base64 encoding to avoid shell escaping issues
	encoded := base64.StdEncoding.EncodeToString(content)
	cmd := fmt.Sprintf("echo '%s' | base64 -d > '%s'", encoded, remotePath)
	session, err := srv.client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	return session.Run(cmd)
}

// ResizeShell resizes the PTY for the given session
func (srv *Server) ResizeShell(sessionID string, cols, rows int) error {
	srv.mu.RLock()
	defer srv.mu.RUnlock()
	// Session management would need to be implemented
	// For now, this is a placeholder
	return nil
}

type RemoteStats struct {
	CPU       RemoteCPU    `json:"cpu"`
	Memory    RemoteMemory `json:"memory"`
	Disk      []RemoteDisk `json:"disk"`
	Network   []RemoteNet  `json:"network"`
	Processes []RemoteProc `json:"procs"`
	GPUs      []RemoteGPU  `json:"gpus"`
	Connected bool         `json:"connected"`
	Error     string       `json:"error,omitempty"`
}

type RemoteCPU struct {
	Load    []float64 `json:"load"`
	Cores   int       `json:"cores"`
	Percent float64   `json:"percent"`
}

type RemoteMemory struct {
	Used   uint64  `json:"used"`
	Total  uint64  `json:"total"`
	UsedPct float64 `json:"usedPct"`
}

type RemoteDisk struct {
	Device  string `json:"device"`
	Mount   string `json:"mount"`
	Total   uint64 `json:"total"`
	Used    uint64 `json:"used"`
	UsedPct int    `json:"usedPct"`
}

type RemoteNet struct {
	Name    string `json:"name"`
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

type RemoteProc struct {
	PID  int32   `json:"pid"`
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"`
	Mem  float64 `json:"mem"`
}

type RemoteGPU struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Util    int    `json:"util"`
	MemUsed int    `json:"memUsed"`
	MemTotal int   `json:"memTotal"`
	Temp    int    `json:"temp"`
}

func (srv *Server) GetStats() RemoteStats {
	var stats RemoteStats
	stats.Connected = srv.Connected

	if !srv.Connected {
		stats.Error = "未连接"
		return stats
	}

	cmd := `
		echo "STATS_BEGIN";
		uptime | awk -F'load average:' '{print $2}' | awk '{print $1,$2,$3}';
		nproc 2>/dev/null || echo 1;
		top -bn1 2>/dev/null | grep "Cpu(s)" | awk '{print "CPUPCT:"$2}' | cut -d'%' -f1 || echo "CPUPCT:0";
		free -m 2>/dev/null | grep Mem | awk '{print "MEM:"$3":"$2":"int($3/$2*100)}' || echo "MEM:0:0:0";
		df -h | tail -n+2 | grep "^/" | awk '{print "DISK:"$1":"$6":"$2":"$3":"$5}';
		cat /proc/net/dev | grep ":" | grep -v "lo:" | awk -F: '{print "NET:"$1":"$2}' | awk '{print $1":"$2":"$10}' | head -5;
		ps aux --sort=-%cpu | head -11 | tail -10 | awk '{print "PROC:"$2":"$11":"$3":"$4}';
		nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/, /,/g' | while read line; do echo "GPU:$line"; done;
		echo "STATS_END";
	`

	out, err := srv.run(cmd)
	if err != nil {
		stats.Error = err.Error()
		return stats
	}

	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "STATS_") {
			continue
		}
		if strings.HasPrefix(line, "CPUPCT:") {
			fmt.Sscanf(strings.TrimPrefix(line, "CPUPCT:"), "%f", &stats.CPU.Percent)
		} else if strings.HasPrefix(line, "MEM:") {
			parts := strings.Split(strings.TrimPrefix(line, "MEM:"), ":")
			if len(parts) >= 3 {
				fmt.Sscanf(parts[0], "%d", &stats.Memory.Used)
				stats.Memory.Used *= 1024 * 1024
				fmt.Sscanf(parts[1], "%d", &stats.Memory.Total)
				stats.Memory.Total *= 1024 * 1024
				fmt.Sscanf(parts[2], "%f", &stats.Memory.UsedPct)
			}
		} else if strings.HasPrefix(line, "DISK:") {
			parts := strings.Split(strings.TrimPrefix(line, "DISK:"), ":")
			if len(parts) >= 5 {
				var d RemoteDisk
				d.Device = parts[0]
				d.Mount = parts[1]
				d.Total = parseSize(parts[2])
				d.Used = parseSize(parts[3])
				fmt.Sscanf(strings.TrimSuffix(parts[4], "%"), "%d", &d.UsedPct)
				stats.Disk = append(stats.Disk, d)
			}
		} else if strings.HasPrefix(line, "NET:") {
			parts := strings.Split(strings.TrimPrefix(line, "NET:"), ":")
			if len(parts) >= 3 {
				var rx, tx uint64
				fmt.Sscanf(parts[1], "%d", &rx)
				fmt.Sscanf(parts[2], "%d", &tx)
				stats.Network = append(stats.Network, RemoteNet{Name: parts[0], RxBytes: rx, TxBytes: tx})
			}
		} else if strings.HasPrefix(line, "PROC:") {
			parts := strings.Split(strings.TrimPrefix(line, "PROC:"), ":")
			if len(parts) >= 4 {
				var p RemoteProc
				fmt.Sscanf(parts[0], "%d", &p.PID)
				p.Name = parts[1]
				fmt.Sscanf(parts[2], "%f", &p.CPU)
				fmt.Sscanf(parts[3], "%f", &p.Mem)
				stats.Processes = append(stats.Processes, p)
			}
		} else if strings.HasPrefix(line, "GPU:") {
			parts := strings.Split(strings.TrimPrefix(line, "GPU:"), ",")
			if len(parts) >= 6 {
				var g RemoteGPU
				fmt.Sscanf(strings.TrimSpace(parts[0]), "%d", &g.Index)
				g.Name = strings.TrimSpace(parts[1])
				fmt.Sscanf(strings.TrimSpace(parts[2]), "%d", &g.Util)
				fmt.Sscanf(strings.TrimSpace(parts[3]), "%d", &g.MemUsed)
				fmt.Sscanf(strings.TrimSpace(parts[4]), "%d", &g.MemTotal)
				fmt.Sscanf(strings.TrimSpace(parts[5]), "%d", &g.Temp)
				stats.GPUs = append(stats.GPUs, g)
			}
		} else if !strings.HasPrefix(line, "STATS_END") {
			// CPU load average line
			fields := strings.Fields(line)
			for _, f := range fields {
				var v float64
				if _, err := fmt.Sscanf(f, "%f", &err); err == nil {
					stats.CPU.Load = append(stats.CPU.Load, v)
				}
			}
		}
	}

	return stats
}

func parseSize(s string) uint64 {
	s = strings.TrimSpace(s)
	var val float64
	var unit string
	fmt.Sscanf(s, "%f%s", &val, &unit)
	switch strings.ToUpper(unit) {
	case "K", "KB": val *= 1024
	case "M", "MB": val *= 1024 * 1024
	case "G", "GB": val *= 1024 * 1024 * 1024
	case "T", "TB": val *= 1024 * 1024 * 1024 * 1024
	}
	return uint64(val)
}

func (srv *Server) ListFiles(path string) (string, error) {
	cmd := fmt.Sprintf(`find '%s' -maxdepth 20 -type f -printf "%%p|%%s|%%T@\\n" 2>/dev/null | head -500`, path)
	return srv.run(cmd)
}

func (srv *Server) ReadFile(path string, offset, limit int64) (string, error) {
	cmd := fmt.Sprintf(`cat '%s' | tail -c +%d | head -c %d`, path, offset+1, limit)
	return srv.run(cmd)
}

func (srv *Server) WriteFile(path string, content string) error {
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	cmd := fmt.Sprintf(`echo '%s' | base64 -d > '%s'`, encoded, path)
	_, err := srv.run(cmd)
	return err
}

func (srv *Server) ReadLog(path string, lines int) (string, error) {
	cmd := fmt.Sprintf(`tail -n %d '%s' 2>/dev/null`, lines, path)
	return srv.run(cmd)
}

var shellUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (srv *Server) HandleShell(w http.ResponseWriter, r *http.Request) {
	if !srv.Connected {
		http.Error(w, "not connected", 400)
		return
	}

	conn, err := shellUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	srv.mu.RLock()
	session, err := srv.client.NewSession()
	srv.mu.RUnlock()
	if err != nil {
		return
	}
	defer session.Close()

	session.RequestPty("xterm-256color", 40, 120, ssh.TerminalModes{})
	stdin, _ := session.StdinPipe()
	stdout, _ := session.StdoutPipe()
	stderr, _ := session.StderrPipe()
	session.Shell()

	// Forward WS -> stdin
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			stdin.Write(data)
		}
	}()

	// Forward stdout -> WS
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.TextMessage, buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()

	// Forward stderr -> WS
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.TextMessage, buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()

	// Wait for disconnect
	<-make(chan struct{})
}

func TestConnection(host string, port int, user, password string) error {
	config := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout: 10 * time.Second,
	}
	addr := fmt.Sprintf("%s:%d", host, port)
	_, err := ssh.Dial("tcp", addr, config)
	return err
}
