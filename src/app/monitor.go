package app

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Read-only statistics run in a separate SSH channel; no remote agent is installed.
const monitorCommand = `LC_ALL=C; export LC_ALL
if [ "$(uname -s)" != Linux ]; then printf 'ORBIT_UNSUPPORTED\n'; exit 42; fi
orbit_collect() {
  key=$1; shift
  if command -v timeout >/dev/null 2>&1; then
    value=$(timeout 2 sh -c "$1" 2>&1); status=$?
  else
    value=$(sh -c "$1" 2>&1); status=$?
  fi
  if [ "$status" -eq 0 ]; then
    printf '__ORBIT_%s__\n%s\n' "$key" "$value"
  else
    printf '__ORBIT_ERROR_%s__\nexit=%s\n%s\n' "$key" "$status" "$value"
  fi
  printf '__ORBIT_DONE_%s__\n' "$key"
}
orbit_collect HOSTNAME 'hostname'
orbit_collect SYSTEM 'uname -sr'
orbit_collect UPTIME 'cat /proc/uptime'
orbit_collect LOAD 'cat /proc/loadavg'
orbit_collect CPU 'cat /proc/stat'
orbit_collect MEMORY 'cat /proc/meminfo'
orbit_collect NETWORK 'cat /proc/net/dev'
orbit_collect DISKIO 'cat /proc/diskstats'
orbit_collect DISKS 'df -Pk -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -Pk'
orbit_collect THERMAL 'for z in /sys/class/thermal/thermal_zone*/temp; do [ -e "$z" ] || continue; t=$(cat "$z") || exit; n=${z%/temp}; n=${n##*/}; type=$(cat "${z%temp}type") || exit; printf "%s %s %s\n" "$n" "$t" "$type"; done'
orbit_collect PROCESSES 'p=$(ps -eo pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu) || exit; printf "%s\n" "$p" | head -n 500'
orbit_collect PROCESS_TOTAL 'p=$(ps -e -o pid=) || exit; printf "%s\n" "$p" | wc -l'
`

type DiskMetric struct {
	Filesystem  string  `json:"filesystem"`
	Mount       string  `json:"mount"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Available   uint64  `json:"available"`
	UsedPercent float64 `json:"usedPercent"`
}
type NetworkMetric struct {
	Interface string  `json:"interface"`
	RxBytes   uint64  `json:"rxBytes"`
	TxBytes   uint64  `json:"txBytes"`
	RxRate    float64 `json:"rxRate"`
	TxRate    float64 `json:"txRate"`
}
type DiskIOMetric struct {
	Device      string  `json:"device"`
	ReadBytes   uint64  `json:"readBytes"`
	WriteBytes  uint64  `json:"writeBytes"`
	ReadOps     uint64  `json:"readOps"`
	WriteOps    uint64  `json:"writeOps"`
	ReadRate    float64 `json:"readRate"`
	WriteRate   float64 `json:"writeRate"`
	BusyPercent float64 `json:"busyPercent,omitempty"`
}
type ThermalMetric struct {
	Zone    string  `json:"zone"`
	Type    string  `json:"type"`
	Celsius float64 `json:"celsius"`
}
type ProcessMetric struct {
	PID           int     `json:"pid"`
	User          string  `json:"user"`
	State         string  `json:"state"`
	CPU           float64 `json:"cpu"`
	MemoryPercent float64 `json:"memoryPercent"`
	Memory        uint64  `json:"memory"`
	Elapsed       uint64  `json:"elapsed"`
	Command       string  `json:"command"`
}
type Metrics struct {
	SampledAt       int64             `json:"sampledAt"`
	Hostname        string            `json:"hostname"`
	System          string            `json:"system"`
	Uptime          float64           `json:"uptime"`
	Load            []float64         `json:"load"`
	Cores           int               `json:"cores"`
	CPUPercent      *float64          `json:"cpuPercent"`
	MemoryTotal     uint64            `json:"memoryTotal"`
	MemoryUsed      uint64            `json:"memoryUsed"`
	MemoryAvailable uint64            `json:"memoryAvailable"`
	SwapTotal       uint64            `json:"swapTotal"`
	SwapUsed        uint64            `json:"swapUsed"`
	Disks           []DiskMetric      `json:"disks"`
	Networks        []NetworkMetric   `json:"networks,omitempty"`
	DiskIO          []DiskIOMetric    `json:"diskIo,omitempty"`
	Thermals        []ThermalMetric   `json:"thermals,omitempty"`
	Processes       []ProcessMetric   `json:"processes"`
	ProcessTotal    int               `json:"processTotal"`
	Warnings        []string          `json:"warnings"`
	Issues          map[string]string `json:"issues"`
}
type cpuSample struct {
	total uint64
	idle  uint64
	at    time.Time
}
type netSample struct {
	rx uint64
	tx uint64
}
type boundedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	limit  int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(p) > b.limit-b.buffer.Len() {
		return 0, errors.New("监控输出超出限制")
	}
	return b.buffer.Write(p)
}
func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func (a *App) Monitor(id string) (Metrics, error) {
	s, err := a.session(id)
	if err != nil {
		return Metrics{}, err
	}
	if !s.monitorMu.TryLock() {
		return Metrics{}, errors.New("上一次采样尚未完成")
	}
	defer s.monitorMu.Unlock()
	// Start the timeout before opening the channel, which also requires a server reply.
	type openedSession struct {
		channel *ssh.Session
		err     error
	}
	opened := make(chan openedSession)
	cancel := make(chan struct{})
	defer close(cancel)
	go func() {
		ch, e := s.client.NewSession()
		select {
		case opened <- openedSession{ch, e}:
		case <-cancel:
			if ch != nil {
				ch.Close()
			}
		}
	}()
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	var channel *ssh.Session
	select {
	case result := <-opened:
		channel, err = result.channel, result.err
	case <-s.done:
		return Metrics{}, errors.New("连接已断开")
	case <-timer.C:
		return Metrics{}, errors.New("创建监控 SSH 通道超时（8 秒）：请检查网络和服务器是否允许额外的 session 通道")
	}
	if err != nil {
		return Metrics{}, fmt.Errorf("无法创建监控 SSH 通道：%w；请检查服务器 MaxSessions 或账号的 session 限制，无需改用 root 登录", err)
	}
	defer channel.Close()
	output := &boundedBuffer{limit: 2 * 1024 * 1024}
	stderr := &boundedBuffer{limit: 4096}
	channel.Stdout = output
	channel.Stderr = stderr
	result := make(chan error, 1)
	go func() { result <- channel.Run(monitorCommand) }()
	select {
	case <-s.done:
		return Metrics{}, errors.New("连接已断开")
	case <-timer.C:
		// Completed sections remain useful even when one command blocks. Snapshot
		// buffers are synchronized because SSH may still be delivering output.
		channel.Close()
		metrics, _, parseErr := parseMetrics(completedMonitorOutput(output.String()))
		if parseErr == nil {
			metrics.Warnings = append(metrics.Warnings, "监控采样超过 8 秒，已保留完成的指标；未完成项将在下次刷新重试。若持续超时，请检查慢挂载点、远端命令或网络")
			// Do not use incomplete samples as future rate baselines.
			s.previousCPU = nil
			s.previousNet = nil
			s.previousDiskIO = nil
			return metrics, nil
		}
		return Metrics{}, monitorReadError(errors.New("监控采样超时（8 秒），尚未收到有效指标；请检查网络、受限 shell 和远端命令"), stderr.String())
	case err = <-result:
	}
	// ps includes this script in its own shell's arguments. A marker inside a
	// process command is data; only the explicit failure response is an error.
	var exitError *ssh.ExitError
	if errors.As(err, &exitError) && exitError.ExitStatus() == 42 && strings.TrimSpace(output.String()) == "ORBIT_UNSUPPORTED" {
		return Metrics{}, errors.New("当前监控支持 Linux 服务器（需要 /proc、df 和 procps ps）")
	}
	if err != nil {
		return Metrics{}, monitorReadError(err, stderr.String())
	}
	metrics, sample, err := parseMetrics(output.String())
	if err != nil {
		return Metrics{}, monitorReadError(err, stderr.String())
	}
	previous := s.previousCPU
	if previous != nil && sample.total > previous.total && sample.idle >= previous.idle && time.Since(previous.at) < time.Minute {
		total := sample.total - previous.total
		idle := sample.idle - previous.idle
		value := math.Max(0, math.Min(100, (1-float64(idle)/float64(total))*100))
		metrics.CPUPercent = &value
	}
	if sample.total > 0 {
		s.previousCPU = &sample
	} else {
		s.previousCPU = nil
	}
	now := time.Now()
	if s.previousNet != nil && !s.previousNetAt.IsZero() {
		seconds := now.Sub(s.previousNetAt).Seconds()
		if seconds > 0 {
			for i := range metrics.Networks {
				previous, ok := s.previousNet[metrics.Networks[i].Interface]
				if !ok {
					continue
				}
				if metrics.Networks[i].RxBytes >= previous.rx {
					metrics.Networks[i].RxRate = float64(metrics.Networks[i].RxBytes-previous.rx) / seconds
				}
				if metrics.Networks[i].TxBytes >= previous.tx {
					metrics.Networks[i].TxRate = float64(metrics.Networks[i].TxBytes-previous.tx) / seconds
				}
			}
		}
	}
	s.previousNet = map[string]netSample{}
	for _, network := range metrics.Networks {
		s.previousNet[network.Interface] = netSample{rx: network.RxBytes, tx: network.TxBytes}
	}
	s.previousNetAt = now
	if s.previousDiskIO != nil && !s.previousDiskAt.IsZero() {
		seconds := now.Sub(s.previousDiskAt).Seconds()
		if seconds > 0 {
			for i := range metrics.DiskIO {
				previous, ok := s.previousDiskIO[metrics.DiskIO[i].Device]
				if !ok {
					continue
				}
				if metrics.DiskIO[i].ReadBytes >= previous.rx {
					metrics.DiskIO[i].ReadRate = float64(metrics.DiskIO[i].ReadBytes-previous.rx) / seconds
				}
				if metrics.DiskIO[i].WriteBytes >= previous.tx {
					metrics.DiskIO[i].WriteRate = float64(metrics.DiskIO[i].WriteBytes-previous.tx) / seconds
				}
			}
		}
	}
	s.previousDiskIO = map[string]netSample{}
	for _, disk := range metrics.DiskIO {
		s.previousDiskIO[disk.Device] = netSample{rx: disk.ReadBytes, tx: disk.WriteBytes}
	}
	s.previousDiskAt = now
	return metrics, nil
}

func parseMetrics(output string) (Metrics, cpuSample, error) {
	sections := map[string][]string{}
	section := ""
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "__ORBIT_") && strings.HasSuffix(line, "__") {
			section = strings.TrimSuffix(strings.TrimPrefix(line, "__ORBIT_"), "__")
			if _, exists := sections[section]; !exists {
				sections[section] = []string{}
			}
			continue
		}
		if section != "" && strings.TrimSpace(line) != "" {
			sections[section] = append(sections[section], line)
		}
	}
	m := Metrics{SampledAt: time.Now().UnixMilli(), Load: []float64{}, Disks: []DiskMetric{}, Networks: []NetworkMetric{}, DiskIO: []DiskIOMetric{}, Thermals: []ThermalMetric{}, Processes: []ProcessMetric{}, Warnings: []string{}, Issues: map[string]string{}}
	// Accept the previous metadata format too, but never let a missing metadata
	// field shift all subsequent fields in the current wire format.
	for i, key := range []string{"HOSTNAME", "SYSTEM", "UPTIME", "LOAD", "PROCESS_TOTAL"} {
		if meta := sections["META"]; i < len(meta) && len(sections[key]) == 0 {
			sections[key] = []string{meta[i]}
		}
	}
	issue := func(key, fallback string) {
		detail := strings.TrimSpace(strings.Join(sections["ERROR_"+key], "\n"))
		if detail == "" {
			detail = fallback
		}
		m.Issues[key] = monitorSectionError(key, detail)
	}
	first := func(key string) string { return strings.Join(sections[key], " ") }
	m.Hostname = first("HOSTNAME")
	if m.Hostname == "" {
		issue("HOSTNAME", "服务器未返回主机名")
	}
	m.System = first("SYSTEM")
	if m.System == "" {
		issue("SYSTEM", "服务器未返回内核信息")
	}
	if f := strings.Fields(first("UPTIME")); len(f) > 0 {
		if n, err := strconv.ParseFloat(f[0], 64); err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 {
			m.Uptime = n
		} else {
			issue("UPTIME", "运行时间格式无效")
		}
	} else {
		issue("UPTIME", "无法读取 /proc/uptime")
	}
	load := strings.Fields(first("LOAD"))
	if len(load) >= 3 {
		for _, value := range load[:3] {
			n, err := strconv.ParseFloat(value, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
				break
			}
			m.Load = append(m.Load, n)
		}
	}
	if len(m.Load) != 3 {
		m.Load = []float64{}
		issue("LOAD", "无法读取有效的 /proc/loadavg")
	}
	if n, err := strconv.Atoi(strings.TrimSpace(first("PROCESS_TOTAL"))); err == nil && n >= 0 {
		m.ProcessTotal = n
	} else {
		issue("PROCESS_TOTAL", "无法读取进程总数，请确认 ps 命令可用")
	}
	sample := cpuSample{at: time.Now()}
	for _, line := range sections["CPU"] {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "cpu" && len(fields) >= 5 {
			for i := 1; i < len(fields) && i <= 8; i++ {
				n, err := strconv.ParseUint(fields[i], 10, 64)
				if err != nil {
					issue("CPU", "CPU 计数无法解析")
					break
				}
				sample.total += n
				if i == 4 || i == 5 {
					sample.idle += n
				}
			}
		}
		if strings.HasPrefix(fields[0], "cpu") && len(fields[0]) > 3 && fields[0][3] >= '0' && fields[0][3] <= '9' {
			m.Cores++
		}
	}
	if sample.total == 0 || m.Cores == 0 || m.Issues["CPU"] != "" {
		issue("CPU", "服务器未提供有效 CPU 数据，请检查 /proc/stat 是否可读")
		sample.total, sample.idle, m.Cores = 0, 0, 0
	}
	mem := map[string]uint64{}
	for _, line := range sections["MEMORY"] {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			n, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil && n <= math.MaxUint64/1024 {
				mem[strings.TrimSuffix(fields[0], ":")] = n * 1024
			}
		}
	}
	m.MemoryTotal = mem["MemTotal"]
	available, exists := mem["MemAvailable"]
	if !exists {
		available = mem["MemFree"] + mem["Buffers"] + mem["Cached"] + mem["SReclaimable"]
		if available >= mem["Shmem"] {
			available -= mem["Shmem"]
		}
	}
	_, hasFree := mem["MemFree"]
	if m.MemoryTotal == 0 || (!exists && !hasFree) {
		issue("MEMORY", "服务器未提供有效内存数据，请检查 /proc/meminfo 是否可读")
		m.MemoryTotal = 0
	}
	m.MemoryAvailable = min(available, m.MemoryTotal)
	m.MemoryUsed = m.MemoryTotal - m.MemoryAvailable
	m.SwapTotal = mem["SwapTotal"]
	m.SwapUsed = m.SwapTotal - min(m.SwapTotal, mem["SwapFree"])
	for _, line := range sections["DISKS"] {
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		total, e := strconv.ParseUint(fields[1], 10, 64)
		if e != nil || total == 0 {
			continue
		}
		used, e1 := strconv.ParseUint(fields[2], 10, 64)
		avail, e2 := strconv.ParseUint(fields[3], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		m.Disks = append(m.Disks, DiskMetric{Filesystem: fields[0], Mount: strings.Join(fields[5:], " "), Total: total * 1024, Used: used * 1024, Available: avail * 1024, UsedPercent: math.Max(0, math.Min(100, number(strings.TrimSuffix(fields[4], "%"))))})
	}
	for _, line := range sections["NETWORK"] {
		fields := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(fields) < 10 || fields[0] == "Inter" || fields[0] == "face" {
			continue
		}
		rx, errRx := strconv.ParseUint(fields[1], 10, 64)
		tx, errTx := strconv.ParseUint(fields[9], 10, 64)
		if errRx != nil || errTx != nil {
			continue
		}
		m.Networks = append(m.Networks, NetworkMetric{Interface: fields[0], RxBytes: rx, TxBytes: tx})
	}
	diskIORows := 0
	for _, line := range sections["DISKIO"] {
		f := strings.Fields(line)
		if len(f) < 14 {
			continue
		}
		device := f[2]
		diskIORows++
		if strings.HasPrefix(device, "loop") || strings.HasPrefix(device, "ram") || strings.HasPrefix(device, "dm-") {
			continue
		}
		// Sectors are 512 bytes for the counters used by Linux.
		readSectors, e1 := strconv.ParseUint(f[5], 10, 64)
		writeSectors, e2 := strconv.ParseUint(f[9], 10, 64)
		readOps, e3 := strconv.ParseUint(f[3], 10, 64)
		writeOps, e4 := strconv.ParseUint(f[7], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
			diskIORows--
			continue
		}
		m.DiskIO = append(m.DiskIO, DiskIOMetric{Device: device, ReadBytes: readSectors * 512, WriteBytes: writeSectors * 512, ReadOps: readOps, WriteOps: writeOps})
	}
	for _, line := range sections["THERMAL"] {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		raw, err := strconv.ParseFloat(f[1], 64)
		if err != nil {
			continue
		}
		// Values are millidegrees on most systems, degrees on a few.
		if raw > 1000 {
			raw /= 1000
		}
		if math.IsNaN(raw) || math.IsInf(raw, 0) || raw <= 0 || raw > 200 {
			continue
		}
		label := ""
		if len(f) > 2 {
			label = strings.Join(f[2:], " ")
		}
		m.Thermals = append(m.Thermals, ThermalMetric{Zone: f[0], Type: label, Celsius: raw})
	}
	for _, line := range sections["PROCESSES"] {
		f := strings.Fields(line)
		if len(f) < 8 {
			continue
		}
		pid, e := strconv.Atoi(f[0])
		if e != nil || pid < 1 {
			continue
		}
		rss, e1 := strconv.ParseUint(f[5], 10, 64)
		elapsed, e2 := strconv.ParseUint(f[6], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		m.Processes = append(m.Processes, ProcessMetric{PID: pid, User: f[1], State: f[2], CPU: number(f[3]), MemoryPercent: number(f[4]), Memory: rss * 1024, Elapsed: elapsed, Command: strings.Join(f[7:], " ")})
	}
	if len(m.Disks) == 0 {
		issue("DISKS", "df 未返回有效磁盘容量，请检查命令和挂载点访问权限")
	}
	if len(m.Networks) == 0 {
		issue("NETWORK", "无法读取有效网卡计数，请检查 /proc/net/dev 的读取权限或网络命名空间限制")
	}
	if len(m.DiskIO) == 0 && diskIORows == 0 {
		if _, present := sections["DISKIO"]; !present || len(sections["DISKIO"]) > 0 {
			issue("DISKIO", "无法读取有效的 /proc/diskstats，或当前环境未提供磁盘 I/O 计数")
		}
	}
	if len(m.Processes) == 0 {
		issue("PROCESSES", "无法读取进程列表，请确认已安装支持这些参数的 procps ps")
	}
	// An empty thermal section is expected on many VMs. Only an actual read
	// failure is an issue, not the absence of temperature sensors.
	keys := []string{"HOSTNAME", "SYSTEM", "UPTIME", "LOAD", "CPU", "MEMORY", "DISKS", "NETWORK", "DISKIO", "THERMAL", "PROCESSES", "PROCESS_TOTAL"}
	for _, key := range keys {
		if len(sections["ERROR_"+key]) > 0 {
			issue(key, "采集失败")
		}
		if detail := m.Issues[key]; detail != "" {
			m.Warnings = append(m.Warnings, detail)
		}
	}
	// No usable metrics at all usually means exec was blocked, a forced command
	// ran instead, or the remote shell emitted an unrelated response.
	usable := m.Hostname != "" || m.System != "" || m.Cores > 0 || m.MemoryTotal > 0 || len(m.Load) > 0 || len(m.Disks)+len(m.Networks)+len(m.DiskIO)+len(m.Thermals)+len(m.Processes) > 0 || m.Issues["UPTIME"] == "" || m.Issues["PROCESS_TOTAL"] == ""
	if !usable {
		return m, sample, fmt.Errorf("未收到可用监控数据：%s；请检查账号的非交互命令执行权限、受限 shell 或 ForceCommand 配置", strings.Join(m.Warnings, "；"))
	}
	return m, sample, nil
}

func monitorSectionError(key, detail string) string {
	labels := map[string]string{"HOSTNAME": "主机名", "SYSTEM": "系统信息", "UPTIME": "运行时间", "LOAD": "系统负载", "CPU": "CPU", "MEMORY": "内存", "DISKS": "磁盘容量", "NETWORK": "网络速率", "DISKIO": "磁盘 I/O", "THERMAL": "温度", "PROCESSES": "进程列表", "PROCESS_TOTAL": "进程总数"}
	detail = monitorDetail(detail)
	lower := strings.ToLower(detail)
	switch {
	case strings.Contains(lower, "exit=124"), strings.Contains(lower, "exit=137"):
		detail += "；该项采集超时（2 秒），请检查命令或慢挂载点"
	case strings.Contains(lower, "permission denied"), strings.Contains(lower, "operation not permitted"):
		detail += "；当前 SSH 登录账号权限不足，请检查相关文件的读取权限或隔离策略（不会自动 sudo）"
	case strings.Contains(lower, "not found"), strings.Contains(lower, "exit=127"):
		detail += "；请检查远端命令是否安装，以及非交互 shell 的 PATH"
	case strings.Contains(lower, "invalid option"), strings.Contains(lower, "unrecognized option"), strings.Contains(lower, "unknown option"), strings.Contains(lower, "bad -o"):
		detail += "；远端命令参数不兼容，进程采集需要 procps ps"
	}
	return labels[key] + "：" + detail
}

func monitorDetail(detail string) string {
	// Keep diagnostics bounded and strip terminal control characters before UI.
	detail = strings.Map(func(r rune) rune {
		if r < 32 && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, strings.TrimSpace(detail))
	runes := []rune(detail)
	if len(runes) > 600 {
		return string(runes[:600]) + "…"
	}
	return detail
}

// A timed-out SSH stream can end midway through a row or section. Only expose
// sections whose completion marker arrived; otherwise a truncated counter could
// be mistaken for a valid (but much smaller) value.
func completedMonitorOutput(output string) string {
	end, offset := 0, 0
	for _, line := range strings.SplitAfter(output, "\n") {
		offset += len(line)
		text := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if strings.HasSuffix(line, "\n") && strings.HasPrefix(text, "__ORBIT_DONE_") && strings.HasSuffix(text, "__") {
			end = offset
		}
	}
	return output[:end]
}

func monitorReadError(err error, stderr string) error {
	detail := monitorDetail(stderr)
	if detail == "" {
		return fmt.Errorf("监控读取失败：%w", err)
	}
	return fmt.Errorf("监控读取失败：%w；远端错误：%s", err, detail)
}

func number(value string) float64 {
	n, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return n
}

var allowedSignals = map[string]bool{
	"TERM": true, "KILL": true, "HUP": true, "INT": true, "QUIT": true, "STOP": true, "CONT": true, "USR1": true, "USR2": true,
}

// KillProcess sends a signal to one process over a separate exec channel. It is
// deliberately limited to a small signal set and a positive PID; the caller is
// responsible for confirming the action with the user.
func (a *App) KillProcess(id string, pid int, signal string) error {
	if pid < 1 || pid > 4194304 {
		return errors.New("无效的进程 ID")
	}
	signal = strings.ToUpper(strings.TrimSpace(signal))
	if signal == "" {
		signal = "TERM"
	}
	if !allowedSignals[signal] {
		return errors.New("不支持该信号")
	}
	s, err := a.session(id)
	if err != nil {
		return err
	}
	channel, err := s.client.NewSession()
	if err != nil {
		return fmt.Errorf("无法创建进程操作通道：%w", err)
	}
	defer channel.Close()
	output := &boundedBuffer{limit: 4096}
	channel.Stdout = output
	channel.Stderr = output
	done := make(chan error, 1)
	go func() { done <- channel.Run(fmt.Sprintf("kill -%s %d", signal, pid)) }()
	select {
	case <-s.done:
		return errors.New("连接已断开")
	case <-time.After(10 * time.Second):
		return errors.New("进程操作超时")
	case err = <-done:
	}
	if err != nil {
		message := strings.TrimSpace(output.String())
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("无法向进程 %d 发送 SIG%s：%s", pid, signal, message)
	}
	return nil
}
