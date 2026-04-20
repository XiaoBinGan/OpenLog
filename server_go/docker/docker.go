package docker

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// DockerConfig 定义 Docker 连接配置
type DockerConfig struct {
	SocketPath string `json:"socketPath,omitempty"`
	Host       string `json:"host,omitempty"`
	Port       int    `json:"port,omitempty"`
	TLS        bool   `json:"tls,omitempty"`
	CACert     string `json:"ca,omitempty"`
	Cert       string `json:"cert,omitempty"`
	Key        string `json:"key,omitempty"`
}

// ContainerInfo 容器信息
type ContainerInfo struct {
	ID              string            `json:"id"`
	ShortID         string            `json:"shortId"`
	Names           []string          `json:"names"`
	Image           string            `json:"image"`
	ImageID         string            `json:"imageId"`
	Command         string            `json:"command"`
	Created         string            `json:"created"`
	State           string            `json:"state"`
	Status          string            `json:"status"`
	Ports           []PortInfo        `json:"ports"`
	Labels          map[string]string `json:"labels"`
	Networks        []string          `json:"networks"`
	UpstreamCount   int               `json:"upstreamCount"`
	DownstreamCount int               `json:"downstreamCount"`
	UpstreamIDs     []string          `json:"upstreamIds"`
	DownstreamIDs   []string          `json:"downstreamIds"`
}

// PortInfo 端口映射
type PortInfo struct {
	IP          string `json:"ip"`
	PrivatePort int    `json:"privatePort"`
	PublicPort  int    `json:"publicPort"`
	Type        string `json:"type"`
}

// LogLine 日志行
type LogLine struct {
	Timestamp string `json:"timestamp"`
	Line      string `json:"line"`
	Stream    string `json:"stream"`
}

// LogOptions 日志选项
type LogOptions struct {
	Tail  int    `json:"tail"`
	Since string `json:"since,omitempty"`
}

// TraceResult 链路追踪结果
type TraceResult struct {
	Target          ContainerInfo   `json:"target"`
	ServiceName     string          `json:"serviceName"`
	Upstream        []ContainerInfo `json:"upstream"`
	Downstream      []ContainerInfo `json:"downstream"`
	TotalUpstream   int             `json:"totalUpstream"`
	TotalDownstream int             `json:"totalDownstream"`
}

// DockerInfo Docker 系统信息
type DockerInfo struct {
	Name       string `json:"name"`
	Containers int    `json:"containers"`
	Running    int    `json:"running"`
	Images     int    `json:"images"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	CPUs       int    `json:"cpus"`
	Memory     int64  `json:"memory"`
}

// 连接池
var InstancePool sync.Map

// GetDocker 获取或创建 Docker 客户端
func GetDocker(sourceId string, config DockerConfig) (*DockerClient, error) {
	if client, ok := InstancePool.Load(sourceId); ok {
		return client.(*DockerClient), nil
	}
	client, err := NewDockerClient(config)
	if err != nil {
		return nil, err
	}
	InstancePool.Store(sourceId, client)
	return client, nil
}

// ResetInstance 重置连接
func ResetInstance(sourceId string) {
	InstancePool.Delete(sourceId)
}

// PingDocker 测试 Docker 连接
func PingDocker(sourceId string, config DockerConfig) (*DockerInfo, error) {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return nil, err
	}

	var info struct {
		Name            string `json:"Name"`
		Containers      int    `json:"Containers"`
		ContainersRunning int  `json:"ContainersRunning"`
		Images          int    `json:"Images"`
		ServerVersion   string `json:"ServerVersion"`
		OperatingSystem string `json:"OperatingSystem"`
		Architecture    string `json:"Architecture"`
		NCPU            int    `json:"NCPU"`
		MemTotal        int64  `json:"MemTotal"`
	}

	if err := client.Get("/info", &info); err != nil {
		return nil, err
	}

	return &DockerInfo{
		Name:       info.Name,
		Containers: info.Containers,
		Running:    info.ContainersRunning,
		Images:     info.Images,
		Version:    info.ServerVersion,
		OS:         info.OperatingSystem,
		Arch:       info.Architecture,
		CPUs:       info.NCPU,
		Memory:     info.MemTotal,
	}, nil
}

// ListContainers 获取容器列表
func ListContainers(sourceId string, config DockerConfig) ([]ContainerInfo, error) {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return nil, err
	}

	var rawContainers []struct {
		ID       string   `json:"Id"`
		Names    []string `json:"Names"`
		Image    string   `json:"Image"`
		ImageID  string   `json:"ImageId"`
		Command  string   `json:"Command"`
		Created  int64    `json:"Created"`
		State    string   `json:"State"`
		Status   string   `json:"Status"`
		Ports    []struct {
			IP          string `json:"IP"`
			PrivatePort int    `json:"PrivatePort"`
			PublicPort  int    `json:"PublicPort"`
			Type        string `json:"Type"`
		} `json:"Ports"`
		Labels  map[string]string `json:"Labels"`
		NetworkSettings struct {
			Networks map[string]struct{} `json:"Networks"`
		} `json:"NetworkSettings"`
	}

	if err := client.Get("/containers/json?all=true", &rawContainers); err != nil {
		return nil, err
	}

	containers := make([]ContainerInfo, 0, len(rawContainers))
	for _, c := range rawContainers {
		// 清理 Names（移除前导 /）
		names := make([]string, len(c.Names))
		for i, n := range c.Names {
			names[i] = strings.TrimPrefix(n, "/")
		}

		// 提取端口
		ports := make([]PortInfo, len(c.Ports))
		for i, p := range c.Ports {
			ports[i] = PortInfo{
				IP:          p.IP,
				PrivatePort: p.PrivatePort,
				PublicPort:  p.PublicPort,
				Type:        p.Type,
			}
		}

		// 提取网络
		networks := make([]string, 0, len(c.NetworkSettings.Networks))
		for n := range c.NetworkSettings.Networks {
			networks = append(networks, n)
		}

		containers = append(containers, ContainerInfo{
			ID:       c.ID,
			ShortID:  c.ID[:12],
			Names:    names,
			Image:    c.Image,
			ImageID:  c.ImageID,
			Command:  c.Command,
			Created:  time.Unix(c.Created, 0).Format(time.RFC3339),
			State:    c.State,
			Status:   c.Status,
			Ports:    ports,
			Labels:   c.Labels,
			Networks: networks,
		})
	}

	// 推断上下游
	inferRelationships(containers)
	return containers, nil
}

// inferRelationships 推断容器上下游关系
func inferRelationships(containers []ContainerInfo) {
	for i := range containers {
		c := &containers[i]
		myService := c.Labels["com.docker.compose.service"]
		if myService == "" {
			myService = c.Labels["app"]
		}
		if myService == "" && len(c.Names) > 0 {
			myService = c.Names[0]
		}

		var upstreams, downstreams []string

		for j, other := range containers {
			if i == j {
				continue
			}

			otherService := other.Labels["com.docker.compose.service"]
			if otherService == "" {
				otherService = other.Labels["app"]
			}
			if otherService == "" && len(other.Names) > 0 {
				otherService = other.Names[0]
			}

			// 检查 depends-on label
			deps := other.Labels["depends-on"]
			if deps == "" {
				deps = other.Labels["com.docker.compose.depends_on"]
			}
			if strings.Contains(deps, myService) {
				upstreams = append(upstreams, other.ID[:12])
			}

			// 检查网络共享
			for _, myNet := range c.Networks {
				for _, otherNet := range other.Networks {
					if myNet == otherNet && myNet != "bridge" {
						// 网络共享可能是上下游
						if !contains(upstreams, other.ID[:12]) && !contains(downstreams, other.ID[:12]) {
							downstreams = append(downstreams, other.ID[:12])
						}
					}
				}
			}
		}

		c.UpstreamIDs = upstreams
		c.DownstreamIDs = downstreams
		c.UpstreamCount = len(upstreams)
		c.DownstreamCount = len(downstreams)
	}
}

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// GetContainerLogs 获取容器日志
func GetContainerLogs(sourceId, containerId string, config DockerConfig, opts LogOptions) ([]LogLine, error) {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return nil, err
	}

	tail := opts.Tail
	if tail == 0 {
		tail = 200
	}

	path := fmt.Sprintf("/containers/%s/logs?stdout=true&stderr=true&tail=%d&timestamps=true", containerId, tail)
	stream, err := client.PostStream(path, nil)
	if err != nil {
		return nil, err
	}
	defer stream.Close()

	return parseDockerLogStream(stream)
}

// parseDockerLogStream 解析 Docker 多流日志格式
func parseDockerLogStream(stream io.Reader) ([]LogLine, error) {
	var lines []LogLine
	header := make([]byte, 8)

	for {
		_, err := io.ReadFull(stream, header)
		if err == io.EOF {
			break
		}
		if err != nil {
			return lines, err
		}

		// 8字节头: [streamType(4字节)] [size(4字节大端)]
		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}

		payload := make([]byte, size)
		_, err = io.ReadFull(stream, payload)
		if err != nil {
			return lines, err
		}

		// 解析时间戳和内容
		text := string(payload)
		var timestamp, line string
		if idx := strings.Index(text, " "); idx > 0 && len(text[:idx]) > 10 {
			timestamp = text[:idx]
			line = text[idx+1:]
		} else {
			timestamp = time.Now().Format(time.RFC3339)
			line = text
		}

		streamType := "stdout"
		if header[0] == 2 {
			streamType = "stderr"
		}

		lines = append(lines, LogLine{
			Timestamp: timestamp,
			Line:      strings.TrimRight(line, "\n"),
			Stream:    streamType,
		})
	}

	return lines, nil
}

// TraceContainerLinks 追踪容器链路
func TraceContainerLinks(sourceId, containerId string, config DockerConfig) (*TraceResult, error) {
	containers, err := ListContainers(sourceId, config)
	if err != nil {
		return nil, err
	}

	var target *ContainerInfo
	for i := range containers {
		if containers[i].ID == containerId || containers[i].ShortID == containerId {
			target = &containers[i]
			break
		}
	}
	if target == nil {
		return nil, fmt.Errorf("容器不存在: %s", containerId)
	}

	var upstream, downstream []ContainerInfo
	for i := range containers {
		for _, id := range target.UpstreamIDs {
			if containers[i].ShortID == id {
				upstream = append(upstream, containers[i])
			}
		}
		for _, id := range target.DownstreamIDs {
			if containers[i].ShortID == id {
				downstream = append(downstream, containers[i])
			}
		}
	}

	serviceName := target.Labels["com.docker.compose.service"]
	if serviceName == "" && len(target.Names) > 0 {
		serviceName = target.Names[0]
	}

	return &TraceResult{
		Target:          *target,
		ServiceName:     serviceName,
		Upstream:        upstream,
		Downstream:      downstream,
		TotalUpstream:   len(upstream),
		TotalDownstream: len(downstream),
	}, nil
}

// StartContainer 启动容器
func StartContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Post(fmt.Sprintf("/containers/%s/start", containerId), nil, nil)
}

// StopContainer 停止容器
func StopContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Post(fmt.Sprintf("/containers/%s/stop?t=10", containerId), nil, nil)
}

// RestartContainer 重启容器
func RestartContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Post(fmt.Sprintf("/containers/%s/restart?t=10", containerId), nil, nil)
}

// PauseContainer 暂停容器
func PauseContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Post(fmt.Sprintf("/containers/%s/pause", containerId), nil, nil)
}

// UnpauseContainer 恢复容器
func UnpauseContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Post(fmt.Sprintf("/containers/%s/unpause", containerId), nil, nil)
}

// RemoveContainer 删除容器
func RemoveContainer(sourceId, containerId string, config DockerConfig) error {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return err
	}
	return client.Delete(fmt.Sprintf("/containers/%s?force=true", containerId))
}

// ExecInContainer 在容器内执行命令
func ExecInContainer(sourceId, containerId string, cmd []string, config DockerConfig) (string, error) {
	client, err := GetDocker(sourceId, config)
	if err != nil {
		return "", err
	}

	// 创建 exec 实例
	execReq := map[string]interface{}{
		"AttachStdout": true,
		"AttachStderr": true,
		"Cmd":          cmd,
	}

	var execResp struct {
		ID string `json:"Id"`
	}
	if err := client.Post(fmt.Sprintf("/containers/%s/exec", containerId), execReq, &execResp); err != nil {
		return "", err
	}

	// 启动 exec
	stream, err := client.PostStream(fmt.Sprintf("/exec/%s/start", execResp.ID), map[string]interface{}{
		"Detach": false,
		"Tty":    false,
	})
	if err != nil {
		return "", err
	}
	defer stream.Close()

	// 读取输出
	output, err := io.ReadAll(stream)
	if err != nil {
		return "", err
	}

	return string(output), nil
}

// BatchGetLogs 批量获取日志
func BatchGetLogs(sources []struct {
	SourceID     string
	ContainerID  string
	ContainerName string
	Config       DockerConfig
}, tail int) []struct {
	SourceID     string
	ContainerID  string
	ContainerName string
	Logs         []LogLine
	Success      bool
	Error        string
} {
	results := make([]struct {
		SourceID     string
		ContainerID  string
		ContainerName string
		Logs         []LogLine
		Success      bool
		Error        string
	}, len(sources))

	for i, s := range sources {
		results[i].SourceID = s.SourceID
		results[i].ContainerID = s.ContainerID
		results[i].ContainerName = s.ContainerName

		logs, err := GetContainerLogs(s.SourceID, s.ContainerID, s.Config, LogOptions{Tail: tail})
		if err != nil {
			results[i].Success = false
			results[i].Error = err.Error()
		} else {
			results[i].Logs = logs
			results[i].Success = true
		}
	}

	return results
}
