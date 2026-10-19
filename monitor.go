package main

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Read-only statistics run in a separate SSH channel; no remote agent is installed.
const monitorCommand = `LC_ALL=C; export LC_ALL
if [ "$(uname -s)" != Linux ] || [ ! -r /proc/stat ]; then printf 'ORBIT_UNSUPPORTED\n'; exit 42; fi
printf '__ORBIT_META__\n'; hostname; uname -sr; cat /proc/uptime; cat /proc/loadavg; ps -e -o pid= 2>/dev/null | wc -l
printf '__ORBIT_CPU__\n'; cat /proc/stat
printf '__ORBIT_MEMORY__\n'; cat /proc/meminfo
printf '__ORBIT_DISKS__\n'; df -Pk -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -Pk
printf '__ORBIT_NETWORK__\n'; cat /proc/net/dev
printf '__ORBIT_DISKIO__\n'; cat /proc/diskstats
printf '__ORBIT_THERMAL__\n'; for z in /sys/class/thermal/thermal_zone*/temp; do [ -r "$z" ] || continue; t=$(cat "$z" 2>/dev/null) || continue; n=${z%/temp}; n=${n##*/}; type=$(cat "${z%temp}type" 2>/dev/null); printf '%s %s %s\n' "$n" "$t" "$type"; done
printf '__ORBIT_PROCESSES__\n'; ps -eo pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu 2>/dev/null | head -n 500
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
	SampledAt       int64           `json:"sampledAt"`
	Hostname        string          `json:"hostname"`
	System          string          `json:"system"`
	Uptime          float64         `json:"uptime"`
	Load            []float64       `json:"load"`
	Cores           int             `json:"cores"`
	CPUPercent      *float64        `json:"cpuPercent"`
	MemoryTotal     uint64          `json:"memoryTotal"`
	MemoryUsed      uint64          `json:"memoryUsed"`
	MemoryAvailable uint64          `json:"memoryAvailable"`
	SwapTotal       uint64          `json:"swapTotal"`
	SwapUsed        uint64          `json:"swapUsed"`
	Disks           []DiskMetric    `json:"disks"`
	Networks        []NetworkMetric `json:"networks,omitempty"`
	DiskIO          []DiskIOMetric  `json:"diskIo,omitempty"`
	Thermals        []ThermalMetric `json:"thermals,omitempty"`
	Processes       []ProcessMetric `json:"processes"`
	ProcessTotal    int             `json:"processTotal"`
	Warnings        []string        `json:"warnings"`
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
	buffer bytes.Buffer
	limit  int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		return 0, errors.New("监控输出超出限制")
	}
	return b.buffer.Write(p)
}
func (b *boundedBuffer) String() string { return b.buffer.String() }

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
		return Metrics{}, errors.New("监控采样超时，可稍后重试")
	}
	if err != nil {
		return Metrics{}, err
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
		return Metrics{}, errors.New("监控采样超时，可稍后重试")
	case err = <-result:
	}
	// ps includes this script in its own shell's arguments. A marker inside a
	// process command is data; only the explicit failure response is an error.
	var exitError *ssh.ExitError
	if errors.As(err, &exitError) && exitError.ExitStatus() == 42 && strings.TrimSpace(output.String()) == "ORBIT_UNSUPPORTED" {
		return Metrics{}, errors.New("当前监控支持 Linux 服务器（需要 /proc、df 和 procps ps）")
	}
	if err != nil {
		return Metrics{}, fmt.Errorf("监控读取失败：%w", err)
	}
	metrics, sample, err := parseMetrics(output.String())
	if err != nil {
		return Metrics{}, err
	}
	previous := s.previousCPU
	if previous != nil && sample.total > previous.total && sample.idle >= previous.idle && time.Since(previous.at) < time.Minute {
		total := sample.total - previous.total
		idle := sample.idle - previous.idle
		value := math.Max(0, math.Min(100, (1-float64(idle)/float64(total))*100))
		metrics.CPUPercent = &value
	}
	s.previousCPU = &sample
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
			continue
		}
		if section != "" && strings.TrimSpace(line) != "" {
			sections[section] = append(sections[section], line)
		}
	}
	m := Metrics{SampledAt: time.Now().UnixMilli(), Load: []float64{}, Disks: []DiskMetric{}, Networks: []NetworkMetric{}, DiskIO: []DiskIOMetric{}, Thermals: []ThermalMetric{}, Processes: []ProcessMetric{}, Warnings: []string{}}
	meta := sections["META"]
	if len(meta) < 4 {
		return m, cpuSample{}, errors.New("监控数据不完整，无法读取系统信息")
	}
	m.Hostname = meta[0]
	m.System = meta[1]
	m.Uptime = number(strings.Fields(meta[2])[0])
	load := strings.Fields(meta[3])
	for i := 0; i < 3 && i < len(load); i++ {
		m.Load = append(m.Load, number(load[i]))
	}
	if len(meta) > 4 {
		m.ProcessTotal, _ = strconv.Atoi(strings.TrimSpace(meta[4]))
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
					return m, sample, errors.New("CPU 计数无法解析")
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
	if sample.total == 0 || m.Cores == 0 {
		return m, sample, errors.New("服务器未提供有效 CPU 数据")
	}
	mem := map[string]uint64{}
	for _, line := range sections["MEMORY"] {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			n, _ := strconv.ParseUint(fields[1], 10, 64)
			mem[strings.TrimSuffix(fields[0], ":")] = n * 1024
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
	if m.MemoryTotal == 0 {
		return m, sample, errors.New("服务器未提供内存数据")
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
	for _, line := range sections["DISKIO"] {
		f := strings.Fields(line)
		if len(f) < 14 {
			continue
		}
		device := f[2]
		if strings.HasPrefix(device, "loop") || strings.HasPrefix(device, "ram") || strings.HasPrefix(device, "dm-") {
			continue
		}
		// Sectors are 512 bytes for the counters used by Linux.
		readSectors, _ := strconv.ParseUint(f[5], 10, 64)
		writeSectors, _ := strconv.ParseUint(f[9], 10, 64)
		readOps, _ := strconv.ParseUint(f[3], 10, 64)
		writeOps, _ := strconv.ParseUint(f[7], 10, 64)
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
		if raw <= 0 || raw > 200 {
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
		m.Warnings = append(m.Warnings, "无法读取磁盘信息")
	}
	if len(m.Processes) == 0 {
		m.Warnings = append(m.Warnings, "无法读取进程列表，请确认已安装 procps ps")
	}
	return m, sample, nil
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
