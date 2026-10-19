import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  backend,
  errorText,
  listen,
  readClipboard,
  writeClipboard,
} from "./bridge";
import TerminalContextMenu, {
  type TerminalAction,
} from "./TerminalContextMenu";
import type { Session, TerminalHandle } from "./types";
import { androidCall, isAndroid } from "./android";
import { installAndroidTerminalTouch } from "./androidTerminal";
import { sessionDetailLabel } from "./sessions";
import "@xterm/xterm/css/xterm.css";

interface Props {
  session: Session;
  active: boolean;
  dark: boolean;
  fontSize: number;
  lineHeight: number;
  onZoom: (direction: -1 | 1) => void;
  onClosed: (id: string, message: string) => void;
  onError: (message: string) => void;
  historyEnabled: boolean;
  onHistoryOutput: (session: Session, output: string) => void;
  onPaste: (text: string) => void;
  onSearch: () => void;
}

function terminalBufferText(term: Terminal) {
  const lines: string[] = [];
  const buffer = term.buffer.active;
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n").replace(/\n+$/, "");
}

const terminalTheme = (dark: boolean) =>
  dark
    ? {
        background: "#171c20",
        foreground: "#dbe5df",
        cursor: "#77d8ae",
        cursorAccent: "#171c20",
        selectionBackground: "#31624e80",
        selectionInactiveBackground: "#35483f80",
        black: "#1c242a",
        red: "#f29494",
        green: "#86d9ae",
        yellow: "#e6cf8c",
        blue: "#9dbff5",
        magenta: "#c3acef",
        cyan: "#8fd8dd",
        white: "#dbe5df",
        brightBlack: "#98aaa0",
        brightRed: "#ffb0ad",
        brightGreen: "#a5e7bd",
        brightYellow: "#f5dfa1",
        brightBlue: "#b4d1ff",
        brightMagenta: "#d8c0ff",
        brightCyan: "#a2e7e8",
        brightWhite: "#f1f5f2",
      }
    : {
        background: "#e8ede9",
        foreground: "#2e3b34",
        cursor: "#236a4d",
        cursorAccent: "#e8ede9",
        selectionBackground: "#accdbbb3",
        selectionInactiveBackground: "#bdcabe80",
        black: "#29362f",
        red: "#a9393e",
        green: "#266740",
        yellow: "#795c1e",
        blue: "#355f99",
        magenta: "#795195",
        cyan: "#246873",
        white: "#d3ddd5",
        brightBlack: "#5f6c63",
        brightRed: "#b53f43",
        brightGreen: "#2b7048",
        brightYellow: "#826323",
        brightBlue: "#3b64a5",
        brightMagenta: "#83549f",
        brightCyan: "#27717b",
        brightWhite: "#f1f5f1",
      };

export const TerminalPane = forwardRef<TerminalHandle, Props>(
  function TerminalPane(
    {
      session,
      active,
      dark,
      fontSize,
      lineHeight,
      onZoom,
      onClosed,
      onError,
      historyEnabled,
      onHistoryOutput,
      onPaste,
      onSearch,
    },
    ref,
  ) {
    const container = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const ready = useRef(false);
    const fit = useRef<FitAddon | null>(null);
    const search = useRef<SearchAddon | null>(null);
    const demoInput = useRef("");
    const writes = useRef<Promise<void>>(Promise.resolve());
    const outputDecoder = useRef(new TextDecoder());
    const historyOutput = useRef("");
    const historyOutputTimer = useRef<number | undefined>(undefined);
    const requestFit = useRef(() => {});
    const [menu, setMenu] = useState<{
      x: number;
      y: number;
      hasSelection: boolean;
    } | null>(null);
    const [control, setControl] = useState(false);
    const controlRef = useRef(false);
    const latest = useRef({
      session,
      active,
      onClosed,
      onError,
      historyEnabled,
      onHistoryOutput,
      onPaste,
      onZoom,
      onSearch,
    });
    latest.current = {
      session,
      active,
      onClosed,
      onError,
      historyEnabled,
      onHistoryOutput,
      onPaste,
      onZoom,
      onSearch,
    };
    const closeMenu = useCallback((restoreFocus = false) => {
      setMenu(null);
      if (restoreFocus && latest.current.active) terminal.current?.focus();
    }, []);

    function flushHistoryOutput() {
      if (historyOutputTimer.current !== undefined) {
        clearTimeout(historyOutputTimer.current);
        historyOutputTimer.current = undefined;
      }
      const output = historyOutput.current;
      historyOutput.current = "";
      if (output && latest.current.historyEnabled)
        latest.current.onHistoryOutput(latest.current.session, output);
    }
    function captureHistoryOutput(data: string | Uint8Array) {
      const output =
        typeof data === "string"
          ? outputDecoder.current.decode() + data
          : outputDecoder.current.decode(data, { stream: true });
      if (!output || !latest.current.historyEnabled) return;
      historyOutput.current += output;
      if (historyOutputTimer.current === undefined)
        historyOutputTimer.current = window.setTimeout(
          flushHistoryOutput,
          350,
        );
    }
    function writeOutput(term: Terminal, data: string | Uint8Array) {
      captureHistoryOutput(data);
      term.write(data);
    }
    function writeLine(term: Terminal, data: string) {
      captureHistoryOutput(`${data}\r\n`);
      term.writeln(data);
    }

    function copy(text: string) {
      if (!text) return;
      void writeClipboard(text).catch(() =>
        latest.current.onError("无法写入剪贴板，请重试。"),
      );
    }
    function pasteFromClipboard() {
      if (latest.current.session.status !== "connected") return;
      void readClipboard()
        .then((text) => {
          if (terminal.current && latest.current.session.status === "connected")
            latest.current.onPaste(text);
        })
        .catch(() =>
          latest.current.onError("无法读取剪贴板，请重试或使用系统粘贴。"),
        );
    }
    function showMenu(x: number, y: number) {
      if (isAndroid() || !latest.current.active) return;
      setMenu({
        x,
        y,
        hasSelection: terminal.current?.hasSelection() ?? false,
      });
    }
    function menuAction(action: TerminalAction) {
      const term = terminal.current;
      closeMenu(action !== "search");
      if (!term) return;
      if (action === "copy") copy(term.getSelection());
      else if (action === "paste") pasteFromClipboard();
      else if (action === "selectAll") term.selectAll();
      else if (action === "clear") term.clear();
      else if (action === "search") latest.current.onSearch();
      else if (action === "copyAll") {
        copy(terminalBufferText(term));
      }
    }

    function send(text: string) {
      if (controlRef.current && text.length === 1) {
        const code = text.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) text = String.fromCharCode(code & 31);
        controlRef.current = false;
        setControl(false);
      }
      if (session.demo) demoType(text);
      else if (latest.current.session.status === "connected") {
        writes.current = writes.current
          .then(() => backend().WriteTerminal(session.id, text))
          .catch((e) => latest.current.onError(errorText(e)));
      }
    }
    function prompt() {
      const term = terminal.current;
      if (!term) return;
      writeOutput(
        term,
        "\x1b[32mexplorer\x1b[0m \x1b[90m@\x1b[0m \x1b[36morbit\x1b[0m \x1b[90m~\x1b[0m\r\n\x1b[32m❯\x1b[0m ",
      );
    }
    function demoType(data: string) {
      const term = terminal.current;
      if (!term || data.startsWith("\x1b")) return;
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          writeOutput(term, "\r\n");
          const command = demoInput.current.trim();
          demoInput.current = "";
          const outputs: Record<string, string> = {
            help: "  whoami     当前用户\r\n  pwd        当前目录\r\n  ls -la     文件列表\r\n  uname -a   系统信息\r\n  df -h      磁盘用量\r\n  colors     ANSI 配色预览\r\n  date       当前时间\r\n  clear      清空终端",
            whoami: "explorer",
            pwd: "/home/explorer",
            ls: "\x1b[34mprojects/  documents/\x1b[0m  welcome.txt",
            "ls -la":
              "drwxr-xr-x  explorer  projects/\r\ndrwxr-xr-x  explorer  documents/\r\n-rw-r--r--  explorer  welcome.txt",
            "uname -a": "Orbit Sandbox · 本地演示环境（非远程服务器）",
            "df -h":
              "Filesystem      Size  Used  Avail  Use%  Mounted on\r\nDemo disk        40G   12G    28G   30%  /",
            "cat welcome.txt":
              "Your servers. Your space.\r\n欢迎来到你的专属 SSH 工作空间。",
            "ps aux | head -20":
              "USER       PID  %CPU  %MEM  COMMAND\r\nexplorer   101   0.0   0.1  orbit-sandbox (演示)",
            colors:
              [0, 1]
                .map((bright) =>
                  Array.from(
                    { length: 8 },
                    (_, i) =>
                      `\x1b[${(bright ? 90 : 30) + i}m${["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"][i].padEnd(10)}\x1b[0m`,
                  ).join(""),
                )
                .join("\r\n") +
              "\r\n\x1b[1mBold 强调文本\x1b[0m  ·  中文 English 0123456789\r\n\x1b[31mERROR 连接超时\x1b[0m  \x1b[33mWARN 重试中\x1b[0m  \x1b[32mOK 连接成功\x1b[0m",
          };
          if (command === "clear") term.clear();
          else if (command === "date")
            writeLine(term, new Date().toLocaleString("zh-CN"));
          else if (command === "exit")
            writeLine(term, "体验空间会一直在这里。关闭标签即可退出。");
          else if (command.startsWith("echo "))
            writeLine(term, command.slice(5));
          else if (command)
            writeLine(
              term,
              outputs[command] ??
                `演示环境暂不支持：${command}\r\n输入 help 查看可用命令。`,
            );
          prompt();
        } else if (ch === "\x7f" || ch === "\b") {
          if (demoInput.current) {
            demoInput.current = [...demoInput.current].slice(0, -1).join("");
            writeOutput(term, "\b \b");
          }
        } else if (ch === "\x03") {
          demoInput.current = "";
          writeOutput(term, "^C\r\n");
          prompt();
        } else if (ch >= " " && ch !== "\x7f") {
          demoInput.current += ch;
          writeOutput(term, ch);
        }
      }
    }

    useImperativeHandle(ref, () => ({
      ready: () => ready.current,
      send,
      paste: (text) => {
        if (latest.current.session.status === "connected")
          terminal.current?.paste(text);
      },
      pasteFromClipboard,
      clear: () => terminal.current?.clear(),
      focus: () => terminal.current?.focus(),
      readBuffer: () =>
        terminal.current ? terminalBufferText(terminal.current) : "",
      flushHistory: flushHistoryOutput,
      search: (text) =>
        search.current?.findNext(text, { incremental: true }) ?? false,
      size: () => ({
        cols: terminal.current?.cols ?? 100,
        rows: terminal.current?.rows ?? 30,
      }),
    }));

    useEffect(() => {
      const term = new Terminal({
        fontFamily:
          '"Cascadia Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize,
        lineHeight,
        fontWeight: 400,
        fontWeightBold: 600,
        minimumContrastRatio: 4.5,
        drawBoldTextInBrightColors: false,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        cursorInactiveStyle: "outline",
        smoothScrollDuration: matchMedia("(prefers-reduced-motion: reduce)")
          .matches
          ? 0
          : 100,
        scrollback: 10000,
        allowProposedApi: false,
        theme: terminalTheme(dark),
      });
      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      terminal.current = term;
      fit.current = fitAddon;
      search.current = searchAddon;
      const paste = (event: ClipboardEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current.onPaste(
          event.clipboardData?.getData("text/plain") ?? "",
        );
      };
      container.current!.addEventListener("paste", paste, true);
      const contextMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const bounds = container.current!.getBoundingClientRect();
        showMenu(
          event.clientX || bounds.left + 24,
          event.clientY || bounds.top + 24,
        );
      };
      const preserveSelection = (event: MouseEvent) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (!isAndroid()) {
        container.current!.addEventListener("contextmenu", contextMenu, true);
        container.current!.addEventListener("mousedown", preserveSelection, true);
      }
      let disposed = false;
      let fitFrame: number | undefined;
      let lastSize = "";
      const resize = () => {
        if (disposed || fitFrame !== undefined) return;
        fitFrame = requestAnimationFrame(() => {
          fitFrame = undefined;
          const node = container.current;
          if (
            disposed ||
            !term.element ||
            !node ||
            node.clientWidth < 40 ||
            node.clientHeight < 30 ||
            node.closest("[inert]")
          )
            return;
          fitAddon.fit();
          const size = `${term.cols}:${term.rows}`;
          if (
            !session.demo &&
            latest.current.session.status === "connected" &&
            size !== lastSize
          ) {
            lastSize = size;
            void backend()
              .ResizeTerminal(session.id, { cols: term.cols, rows: term.rows })
              .catch(() => {});
          }
        });
      };
      requestFit.current = resize;
      const observer = new ResizeObserver(resize);
      observer.observe(container.current!);
      let disposeAndroidTouch = () => {};
      const openFrame = requestAnimationFrame(() => {
        if (!disposed && container.current) {
          term.open(container.current);
          if (isAndroid()) disposeAndroidTouch = installAndroidTerminalTouch(container.current, term, {
            sessionID: session.id,
            active: () => latest.current.active,
            connected: () => latest.current.session.status === "connected",
            fit: resize,
            zoom: (direction) => latest.current.onZoom(direction),
            paste: (text) => latest.current.onPaste(text),
            error: (message) => latest.current.onError(message),
          });
          resize();
        }
      });
      void document.fonts.ready.then(resize);
      const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
      const motionChanged = () => {
        term.options.smoothScrollDuration = reducedMotion.matches ? 0 : 100;
      };
      reducedMotion.addEventListener("change", motionChanged);
      let lastWheel = 0;
      const wheel = (event: WheelEvent) => {
        if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (performance.now() - lastWheel < 80) return;
        lastWheel = performance.now();
        latest.current.onZoom(event.deltaY < 0 ? 1 : -1);
      };
      container.current!.addEventListener("wheel", wheel, {
        passive: false,
        capture: true,
      });
      const input = term.onData(send);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if (e.altKey) return true;
        const modifier = e.ctrlKey || e.metaKey;
        const consume = () => {
          e.preventDefault();
          e.stopPropagation();
          return false;
        };
        if (
          e.code === "ContextMenu" ||
          (e.shiftKey && !modifier && e.code === "F10")
        ) {
          const bounds = container.current!.getBoundingClientRect();
          showMenu(bounds.left + 24, bounds.top + 24);
          return consume();
        }
        if (
          (modifier &&
            e.code === "KeyC" &&
            (e.shiftKey || e.metaKey || term.hasSelection())) ||
          (e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "Insert")
        ) {
          copy(term.getSelection());
          return consume();
        }
        if (
          (modifier && e.code === "KeyV") ||
          (e.shiftKey && !modifier && e.code === "Insert")
        ) {
          pasteFromClipboard();
          return consume();
        }
        if (modifier && e.code === "KeyA" && (e.shiftKey || e.metaKey)) {
          term.selectAll();
          return consume();
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          (e.code === "KeyK" ||
            e.code === "KeyT" ||
            (e.shiftKey && e.code === "KeyF"))
        )
          return false;
        return true;
      });
      const offData = session.demo
        ? () => {}
        : listen(`ssh:data:${session.id}`, (data) => {
            const binary = atob(String(data));
            writeOutput(
              term,
              Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
            );
          });
      const offClosed = session.demo
        ? () => {}
        : listen(`ssh:closed:${session.id}`, (message) => {
            writeLine(
              term,
              `\r\n\x1b[90m[${session.localShell || session.wslDistribution ? "终端已结束" : "连接已断开"}]\x1b[0m`,
            );
            latest.current.onClosed(session.id, String(message));
          });
      ready.current = true;
      if (session.demo) {
        writeLine(
          term,
          "\x1b[32mOrbit SSH\x1b[0m · 本地演示\r\n输入 help 查看命令，colors 预览配色。\r\n",
        );
        prompt();
      } else {
        const message = session.localShell
          ? `正在启动 ${session.localShell.name}`
          : session.wslDistribution
            ? `正在启动 WSL · ${session.wslDistribution}`
            : `正在连接 ${session.host.username}@${session.host.address}:${session.host.port}`;
        writeLine(term, `\x1b[90m${message} …\x1b[0m\r\n`);
      }
      resize();
      const element = container.current!;
      return () => {
        ready.current = false;
        disposed = true;
        disposeAndroidTouch();
        const trailing = outputDecoder.current.decode();
        if (trailing && latest.current.historyEnabled)
          historyOutput.current += trailing;
        flushHistoryOutput();
        cancelAnimationFrame(openFrame);
        if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
        requestFit.current = () => {};
        element.removeEventListener("paste", paste, true);
        element.removeEventListener("contextmenu", contextMenu, true);
        element.removeEventListener("mousedown", preserveSelection, true);
        element.removeEventListener("wheel", wheel, true);
        reducedMotion.removeEventListener("change", motionChanged);
        observer.disconnect();
        input.dispose();
        offData();
        offClosed();
        term.dispose();
        terminal.current = null;
      };
      // A terminal and its stream subscriptions live for the entire session.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.id]);

    useEffect(() => {
      if (historyEnabled) return;
      historyOutput.current = "";
      if (historyOutputTimer.current !== undefined) {
        clearTimeout(historyOutputTimer.current);
        historyOutputTimer.current = undefined;
      }
      outputDecoder.current.decode();
    }, [historyEnabled]);

    useEffect(() => {
      if (terminal.current) {
        terminal.current.options.theme = terminalTheme(dark);
        terminal.current.options.fontSize = fontSize;
        terminal.current.options.lineHeight = lineHeight;
        requestFit.current();
      }
    }, [dark, fontSize, lineHeight]);
    useEffect(() => {
      if (!active) {
        closeMenu();
        if (isAndroid()) void androidCall("HideTerminalActions", session.id).catch(() => {});
      }
      if (active) {
        const frame = requestAnimationFrame(() => {
          requestFit.current();
          terminal.current?.focus();
        });
        return () => cancelAnimationFrame(frame);
      }
    }, [active, session.status, closeMenu]);
    return (
      <>
        <div
          className="terminal-mount"
          ref={container}
          aria-label={sessionDetailLabel(session)}
        />
        {isAndroid() && active && (
          <div
            className="android-terminal-keys"
            role="toolbar"
            aria-label="终端辅助按键"
          >
            {[
              ["Esc", "\u001b"],
              ["Tab", "\t"],
              ["Ctrl", ""],
              ["↑", "\u001b[A"],
              ["↓", "\u001b[B"],
              ["←", "\u001b[D"],
              ["→", "\u001b[C"],
              ["中断", "\u0003"],
            ].map(([label, value]) => (
              <button
                key={label}
                aria-label={label === "中断" ? "发送 Ctrl+C" : label}
                aria-pressed={label === "Ctrl" ? control : undefined}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (label === "Ctrl") {
                    controlRef.current = !controlRef.current;
                    setControl(controlRef.current);
                  } else send(value);
                  terminal.current?.focus();
                }}
              >
                {label}
              </button>
            ))}
            <button
              onPointerDown={(event) => event.preventDefault()}
              onClick={pasteFromClipboard}
            >
              粘贴
            </button>
            <button
              aria-label="显示软键盘"
              onClick={() => {
                terminal.current?.focus();
                void androidCall("ShowKeyboard").catch(() =>
                  latest.current.onError("无法打开软键盘"),
                );
              }}
            >
              键盘
            </button>
          </div>
        )}
        {!isAndroid() && active && menu && (
          <TerminalContextMenu
            {...menu}
            connected={session.status === "connected"}
            onAction={menuAction}
            onClose={closeMenu}
          />
        )}
      </>
    );
  },
);
