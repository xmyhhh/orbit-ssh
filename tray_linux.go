//go:build linux && !android && !androidtest

package main

/*
Linux uses the StatusNotifierItem specification on the session bus. The desktop
shell draws the icon and the menu, so the implementation stays free of GTK and
cgo and never touches the window toolkit main loop.
*/

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"image/png"
	"os"
	"sync"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

//go:embed build/linux/tray.png
var trayIconPNG []byte

const (
	trayNotifierInterface = "org.kde.StatusNotifierItem"
	trayWatcherInterface  = "org.kde.StatusNotifierWatcher"
	trayWatcherPath       = "/StatusNotifierWatcher"
	trayItemPath          = "/StatusNotifierItem"
	trayMenuPath          = "/StatusNotifierItem/menu"
	trayMenuInterface     = "com.canonical.dbusmenu"
	trayPropertiesIface   = "org.freedesktop.DBus.Properties"
	trayIntrospectIface   = "org.freedesktop.DBus.Introspectable"
)

// trayIconPixmap is one entry of the IconPixmap property, a(iiay).
type trayIconPixmap struct {
	Width  int32
	Height int32
	Pixels []byte
}

// trayToolTip is the ToolTip property, (sa(iiay)ss).
type trayToolTip struct {
	IconName    string
	IconPixmap  []trayIconPixmap
	Title       string
	Description string
}

// trayMenuNode is a DBusMenu layout node, (ia{sv}av).
type trayMenuNode struct {
	ID         int32
	Properties map[string]dbus.Variant
	Children   []dbus.Variant
}

// trayMenuEntry is one item of the notification area menu.
type trayMenuEntry struct {
	id      int32
	title   string
	action  func()
	visible bool
}

// linuxTray publishes the Orbit SSH item on the session bus.
type linuxTray struct {
	mu        sync.Mutex
	conn      *dbus.Conn
	props     *prop.Properties
	menuProps *prop.Properties
	menu      *trayMenuNode
	revision  uint32
	nextID    int32
	entries   map[int32]*trayMenuEntry
	callbacks trayCallbacks
	busName   string
	quit      chan struct{}
	quitOnce  sync.Once
	closed    bool
}

func startSystemTray(callbacks trayCallbacks) (func(), error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, fmt.Errorf("无法连接会话总线：%w", err)
	}
	tray := &linuxTray{
		conn:      conn,
		callbacks: callbacks,
		menu:      &trayMenuNode{ID: 0, Properties: map[string]dbus.Variant{}, Children: []dbus.Variant{}},
		entries:   map[int32]*trayMenuEntry{},
		quit:      make(chan struct{}),
	}
	tray.addEntry("打开 Orbit SSH", callbacks.show)
	tray.addEntry("隐藏到托盘", callbacks.hide)
	tray.addSeparator()
	tray.addEntry("退出 Orbit SSH", callbacks.quit)

	if err := tray.publish(); err != nil {
		tray.unpublish()
		return nil, err
	}
	if err := tray.register(); err != nil {
		tray.unpublish()
		return nil, err
	}
	go tray.followWatcher()
	return tray.close, nil
}

func (t *linuxTray) addEntry(title string, action func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nextID++
	entry := &trayMenuEntry{id: t.nextID, title: title, action: action, visible: true}
	t.entries[entry.id] = entry
	t.appendNode(t.menuNode(entry))
}

func (t *linuxTray) addSeparator() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nextID++
	entry := &trayMenuEntry{id: t.nextID, visible: true}
	t.entries[entry.id] = entry
	node := &trayMenuNode{ID: entry.id, Properties: map[string]dbus.Variant{
		"type": dbus.MakeVariant("separator"),
	}, Children: []dbus.Variant{}}
	t.menu.Children = append(t.menu.Children, dbus.MakeVariant(node))
	t.revision++
}

// menuNode builds the layout node of a normal entry.
func (t *linuxTray) menuNode(entry *trayMenuEntry) *trayMenuNode {
	return &trayMenuNode{ID: entry.id, Properties: map[string]dbus.Variant{
		"label":       dbus.MakeVariant(entry.title),
		"enabled":     dbus.MakeVariant(true),
		"visible":     dbus.MakeVariant(entry.visible),
		"toggle-type": dbus.MakeVariant(""),
		"toggle-state": dbus.MakeVariant(int32(0)),
	}, Children: []dbus.Variant{}}
}

func (t *linuxTray) appendNode(node *trayMenuNode) {
	t.menu.Children = append(t.menu.Children, dbus.MakeVariant(node))
	t.revision++
}

// publish exports the notifier item, its menu and their properties.
func (t *linuxTray) publish() error {
	conn := t.conn
	itemPath := dbus.ObjectPath(trayItemPath)
	menuPath := dbus.ObjectPath(trayMenuPath)

	itemMethods := map[string]interface{}{
		"Activate":          t.activate,
		"SecondaryActivate": t.secondaryActivate,
		"Scroll":            t.scroll,
		"ContextMenu":       t.contextMenu,
	}
	if err := conn.ExportMethodTable(itemMethods, itemPath, trayNotifierInterface); err != nil {
		return fmt.Errorf("无法导出托盘接口：%w", err)
	}
	menuMethods := map[string]interface{}{
		"GetLayout":          t.getLayout,
		"GetGroupProperties": t.getGroupProperties,
		"GetProperty":        t.getProperty,
		"Event":              t.event,
		"AboutToShow":        t.aboutToShow,
	}
	if err := conn.ExportMethodTable(menuMethods, menuPath, trayMenuInterface); err != nil {
		return fmt.Errorf("无法导出托盘菜单：%w", err)
	}

	pixmaps, err := trayIconPixmaps(trayIconPNG)
	if err != nil {
		return fmt.Errorf("无法读取托盘图标：%w", err)
	}
	t.mu.Lock()
	iconPixmap := pixmaps
	revision := t.revision
	t.mu.Unlock()

	props, err := prop.Export(conn, itemPath, map[string]map[string]*prop.Prop{
		trayNotifierInterface: {
			"Category":        {Value: "ApplicationStatus", Emit: prop.EmitTrue},
			"Id":              {Value: "io.orbitssh.tray", Emit: prop.EmitTrue},
			"Title":           {Value: "Orbit SSH", Emit: prop.EmitTrue},
			"Status":          {Value: "Active", Emit: prop.EmitTrue},
			"IconName":        {Value: "", Emit: prop.EmitTrue},
			"IconThemePath":   {Value: "", Emit: prop.EmitTrue},
			"OverlayIconName": {Value: "", Emit: prop.EmitTrue},
			"AttentionIconName": {Value: "", Emit: prop.EmitTrue},
			"AttentionMovieName": {Value: "", Emit: prop.EmitTrue},
			"ItemIsMenu":      {Value: false, Emit: prop.EmitTrue},
			"Menu":            {Value: dbus.ObjectPath(trayMenuPath), Emit: prop.EmitTrue},
			"IconPixmap":      {Value: iconPixmap, Emit: prop.EmitTrue},
			"ToolTip": {
				Value: trayToolTip{IconName: "", IconPixmap: iconPixmap, Title: "Orbit SSH", Description: "点击打开窗口"},
				Emit:  prop.EmitTrue,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("无法导出托盘属性：%w", err)
	}
	menuProps, err := prop.Export(conn, menuPath, map[string]map[string]*prop.Prop{
		trayMenuInterface: {
			"Version":        {Value: revision, Emit: prop.EmitTrue},
			"TextDirection":  {Value: "ltr", Emit: prop.EmitTrue},
			"Status":         {Value: "normal", Emit: prop.EmitTrue},
			"IconThemePath":  {Value: []string{}, Emit: prop.EmitTrue},
		},
	})
	if err != nil {
		return fmt.Errorf("无法导出托盘菜单属性：%w", err)
	}

	t.mu.Lock()
	t.props = props
	t.menuProps = menuProps
	t.mu.Unlock()

	if err := conn.Export(introspect.NewIntrospectable(&introspect.Node{
		Name: trayItemPath,
		Interfaces: []introspect.Interface{
			introspect.IntrospectData,
			prop.IntrospectData,
			{
				Name: trayNotifierInterface,
				Methods: []introspect.Method{
					{Name: "Activate", Args: []introspect.Arg{
						{Name: "x", Type: "i", Direction: "in"},
						{Name: "y", Type: "i", Direction: "in"},
					}},
					{Name: "SecondaryActivate", Args: []introspect.Arg{
						{Name: "x", Type: "i", Direction: "in"},
						{Name: "y", Type: "i", Direction: "in"},
					}},
					{Name: "Scroll", Args: []introspect.Arg{
						{Name: "delta", Type: "i", Direction: "in"},
						{Name: "orientation", Type: "s", Direction: "in"},
					}},
					{Name: "ContextMenu", Args: []introspect.Arg{
						{Name: "x", Type: "i", Direction: "in"},
						{Name: "y", Type: "i", Direction: "in"},
					}},
				},
			},
		},
	}), itemPath, trayIntrospectIface); err != nil {
		return fmt.Errorf("无法导出托盘自省信息：%w", err)
	}
	if err := conn.Export(introspect.NewIntrospectable(&introspect.Node{
		Name: trayMenuPath,
		Interfaces: []introspect.Interface{
			introspect.IntrospectData,
			prop.IntrospectData,
			{
				Name: trayMenuInterface,
				Methods: []introspect.Method{
					{Name: "GetLayout", Args: []introspect.Arg{
						{Name: "parentId", Type: "i", Direction: "in"},
						{Name: "recursionDepth", Type: "i", Direction: "in"},
						{Name: "propertyNames", Type: "as", Direction: "in"},
						{Name: "revision", Type: "u", Direction: "out"},
						{Name: "layout", Type: "(ia{sv}av)", Direction: "out"},
					}},
					{Name: "GetGroupProperties", Args: []introspect.Arg{
						{Name: "ids", Type: "ai", Direction: "in"},
						{Name: "propertyNames", Type: "as", Direction: "in"},
						{Name: "properties", Type: "a(ia{sv})", Direction: "out"},
					}},
					{Name: "GetProperty", Args: []introspect.Arg{
						{Name: "id", Type: "i", Direction: "in"},
						{Name: "name", Type: "s", Direction: "in"},
						{Name: "value", Type: "v", Direction: "out"},
					}},
					{Name: "Event", Args: []introspect.Arg{
						{Name: "id", Type: "i", Direction: "in"},
						{Name: "eventId", Type: "s", Direction: "in"},
						{Name: "data", Type: "v", Direction: "in"},
						{Name: "timestamp", Type: "u", Direction: "in"},
					}},
					{Name: "AboutToShow", Args: []introspect.Arg{
						{Name: "id", Type: "i", Direction: "in"},
						{Name: "needUpdate", Type: "b", Direction: "out"},
					}},
				},
			},
		},
	}), menuPath, trayIntrospectIface); err != nil {
		return fmt.Errorf("无法导出托盘菜单自省信息：%w", err)
	}

	name := fmt.Sprintf("org.kde.StatusNotifierItem-%d-1", os.Getpid())
	if _, err := conn.RequestName(name, dbus.NameFlagDoNotQueue); err != nil {
		return fmt.Errorf("无法注册托盘服务名：%w", err)
	}
	t.mu.Lock()
	t.busName = name
	t.mu.Unlock()
	return nil
}

// register announces the item to the running notification host.
func (t *linuxTray) register() error {
	watcher := t.conn.Object(trayWatcherInterface, dbus.ObjectPath(trayWatcherPath))
	call := watcher.Call(trayWatcherInterface+".RegisterStatusNotifierItem", 0, trayItemPath)
	if call.Err != nil {
		return fmt.Errorf("系统托盘不可用：%w", call.Err)
	}
	if t.callbacks.availability != nil {
		t.callbacks.availability(true)
	}
	return nil
}

// followWatcher re-registers the item when the notification host restarts.
func (t *linuxTray) followWatcher() {
	conn := t.conn
	if err := conn.AddMatchSignal(
		dbus.WithMatchObjectPath("/org/freedesktop/DBus"),
		dbus.WithMatchInterface("org.freedesktop.DBus"),
		dbus.WithMatchSender("org.freedesktop.DBus"),
		dbus.WithMatchMember("NameOwnerChanged"),
		dbus.WithMatchArg(0, trayWatcherInterface),
	); err != nil {
		return
	}
	signals := make(chan *dbus.Signal, 8)
	conn.Signal(signals)
	for {
		select {
		case signal := <-signals:
			if signal == nil {
				return
			}
			if len(signal.Body) < 3 {
				continue
			}
			if owner, ok := signal.Body[2].(string); ok && owner != "" {
				_ = t.register()
			}
		case <-t.quit:
			return
		}
	}
}

// unpublish removes the exported objects and releases the bus name.
func (t *linuxTray) unpublish() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	name := t.busName
	t.mu.Unlock()

	itemPath := dbus.ObjectPath(trayItemPath)
	menuPath := dbus.ObjectPath(trayMenuPath)
	_ = t.conn.Export(nil, itemPath, trayNotifierInterface)
	_ = t.conn.Export(nil, menuPath, trayMenuInterface)
	_ = t.conn.Export(nil, itemPath, trayPropertiesIface)
	_ = t.conn.Export(nil, menuPath, trayPropertiesIface)
	_ = t.conn.Export(nil, itemPath, trayIntrospectIface)
	_ = t.conn.Export(nil, menuPath, trayIntrospectIface)
	if name != "" {
		_, _ = t.conn.ReleaseName(name)
	}
	if t.callbacks.availability != nil {
		t.callbacks.availability(false)
	}
}

func (t *linuxTray) close() {
	t.quitOnce.Do(func() {
		close(t.quit)
		t.unpublish()
	})
}

// activate handles a left click on the tray icon.
func (t *linuxTray) activate(_, _ int32) {
	if t.callbacks.show != nil {
		go t.callbacks.show()
	}
}

func (t *linuxTray) secondaryActivate(_, _ int32) {
	if t.callbacks.show != nil {
		go t.callbacks.show()
	}
}

func (t *linuxTray) scroll(_ int32, _ string) {}

func (t *linuxTray) contextMenu(_, _ int32) {}

// getLayout answers the layout request of the notification host.
func (t *linuxTray) getLayout(parentID int32, recursionDepth int32, _ []string) (uint32, trayMenuNode, *dbus.Error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	revision := t.revision
	node, ok := t.findNode(parentID)
	if !ok {
		return revision, trayMenuNode{ID: 0, Properties: map[string]dbus.Variant{}, Children: []dbus.Variant{}}, nil
	}
	copied := t.copyNode(node, recursionDepth)
	return revision, *copied, nil
}

// findNode locates a menu node by its identifier.
func (t *linuxTray) findNode(id int32) (*trayMenuNode, bool) {
	if id == 0 {
		return t.menu, true
	}
	return t.searchNode(t.menu, id)
}

func (t *linuxTray) searchNode(parent *trayMenuNode, id int32) (*trayMenuNode, bool) {
	for _, child := range parent.Children {
		node, ok := child.Value().(*trayMenuNode)
		if !ok || node == nil {
			continue
		}
		if node.ID == id {
			return node, true
		}
		if found, ok := t.searchNode(node, id); ok {
			return found, true
		}
	}
	return nil, false
}

// copyNode duplicates a layout node and limits the recursion depth.
func (t *linuxTray) copyNode(node *trayMenuNode, depth int32) *trayMenuNode {
	properties := make(map[string]dbus.Variant, len(node.Properties))
	for key, value := range node.Properties {
		properties[key] = value
	}
	children := []dbus.Variant{}
	if depth != 0 {
		for _, child := range node.Children {
			inner, ok := child.Value().(*trayMenuNode)
			if !ok || inner == nil {
				continue
			}
			children = append(children, dbus.MakeVariant(t.copyNode(inner, depth-1)))
		}
	}
	return &trayMenuNode{ID: node.ID, Properties: properties, Children: children}
}

// getGroupProperties answers the properties of several menu items at once.
func (t *linuxTray) getGroupProperties(ids []int32, _ []string) ([]struct {
	ID         int32
	Properties map[string]dbus.Variant
}, *dbus.Error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	properties := []struct {
		ID         int32
		Properties map[string]dbus.Variant
	}{}
	for _, id := range ids {
		node, ok := t.findNode(id)
		if !ok {
			continue
		}
		copied := make(map[string]dbus.Variant, len(node.Properties))
		for key, value := range node.Properties {
			copied[key] = value
		}
		properties = append(properties, struct {
			ID         int32
			Properties map[string]dbus.Variant
		}{ID: node.ID, Properties: copied})
	}
	return properties, nil
}

// getProperty answers a single menu property.
func (t *linuxTray) getProperty(id int32, name string) (dbus.Variant, *dbus.Error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	node, ok := t.findNode(id)
	if !ok {
		return dbus.Variant{}, nil
	}
	value, ok := node.Properties[name]
	if !ok {
		return dbus.Variant{}, nil
	}
	return value, nil
}

// event dispatches the clicks reported by the notification host.
func (t *linuxTray) event(id int32, eventID string, _ dbus.Variant, _ uint32) *dbus.Error {
	if eventID != "clicked" {
		return nil
	}
	t.mu.Lock()
	entry, ok := t.entries[id]
	t.mu.Unlock()
	if ok && entry.action != nil {
		go entry.action()
	}
	return nil
}

// aboutToShow reports that the menu needs no refresh before it opens.
func (t *linuxTray) aboutToShow(_ int32) (bool, *dbus.Error) {
	return false, nil
}

// trayIconPixmaps converts the embedded PNG into the ARGB pixmaps of the
// StatusNotifierItem specification.
func trayIconPixmaps(data []byte) ([]trayIconPixmap, error) {
	if len(data) == 0 {
		return nil, errors.New("托盘图标为空")
	}
	image, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	bounds := image.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, errors.New("托盘图标尺寸无效")
	}
	pixels := make([]byte, 0, width*height*4)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			red, green, blue, alpha := image.At(x, y).RGBA()
			pixels = append(pixels, byte(alpha>>8), byte(red>>8), byte(green>>8), byte(blue>>8))
		}
	}
	return []trayIconPixmap{{Width: int32(width), Height: int32(height), Pixels: pixels}}, nil
}
