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
  onPaste: (text: string) => void;
  onSearch: () => void;
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
      onPaste,
      onSearch,
    },
    ref,
  ) {
    const container = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const fit = useRef<FitAddon | null>(null);
    const search = useRef<SearchAddon | null>(null);
    const demoInput = useRef("");
    const writes = useRef<Promise<void>>(Promise.resolve());
    const requestFit = useRef(() => {});
    const [menu, setMenu] = useState<{
      x: number;
      y: number;
      hasSelection: boolean;
    } | null>(null);
    const latest = useRef({
      session,
      active,
      onClosed,
      onError,
      onPaste,
      onZoom,
      onSearch,
    });
    latest.current = {
      session,
      active,
      onClosed,
      onError,
      onPaste,
      onZoom,
      onSearch,
    };
    const closeMenu = useCallback((restoreFocus = false) => {
      setMenu(null);
      if (restoreFocus && latest.current.active) terminal.current?.focus();
    }, []);

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
      if (!latest.current.active) return;
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
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++) {
          const line = term.buffer.active.getLine(i)!;
          const text = line.translateToString(true);
          if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
          else lines.push(text);
        }
        copy(lines.join("\n").replace(/\n+$/, ""));
      }
    }

    function send(text: string) {
      if (session.demo) demoType(text);
      else if (latest.current.session.status === "connected") {
        writes.current = writes.current
          .then(() => backend().WriteTerminal(session.id, text))
          .catch((e) => latest.current.onError(errorText(e)));
      }
    }
    function prompt() {
      terminal.current?.write(
        "\x1b[32mexplorer\x1b[0m \x1b[90m@\x1b[0m \x1b[36morbit\x1b[0m \x1b[90m~\x1b[0m\r\n\x1b[32m❯\x1b[0m ",
      );
    }
    function demoType(data: string) {
      const term = terminal.current;
      if (!term || data.startsWith("\x1b")) return;
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          term.write("\r\n");
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
            term.writeln(new Date().toLocaleString("zh-CN"));
          else if (command === "exit")
            term.writeln("体验空间会一直在这里。关闭标签即可退出。");
          else if (command.startsWith("echo ")) term.writeln(command.slice(5));
          else if (command)
            term.writeln(
              outputs[command] ??
                `演示环境暂不支持：${command}\r\n输入 help 查看可用命令。`,
            );
          prompt();
        } else if (ch === "\x7f" || ch === "\b") {
          if (demoInput.current) {
            demoInput.current = [...demoInput.current].slice(0, -1).join("");
            term.write("\b \b");
          }
        } else if (ch === "\x03") {
          demoInput.current = "";
          term.write("^C\r\n");
          prompt();
        } else if (ch >= " " && ch !== "\x7f") {
          demoInput.current += ch;
          term.write(ch);
        }
      }
    }

    useImperativeHandle(ref, () => ({
      send,
      paste: (text) => {
        if (latest.current.session.status === "connected")
          terminal.current?.paste(text);
      },
      pasteFromClipboard,
      clear: () => terminal.current?.clear(),
      focus: () => terminal.current?.focus(),
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
      container.current!.addEventListener("contextmenu", contextMenu, true);
      container.current!.addEventListener("mousedown", preserveSelection, true);
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
      const openFrame = requestAnimationFrame(() => {
        if (!disposed && container.current) {
          term.open(container.current);
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
            term.write(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
          });
      const offClosed = session.demo
        ? () => {}
        : listen(`ssh:closed:${session.id}`, (message) => {
            term.writeln(
              `\r\n\x1b[90m[${session.wslDistribution ? "终端已结束" : "连接已断开"}]\x1b[0m`,
            );
            latest.current.onClosed(session.id, String(message));
          });
      if (session.demo) {
        term.writeln(
          "\x1b[32mOrbit SSH\x1b[0m · 本地演示\r\n输入 help 查看命令，colors 预览配色。\r\n",
        );
        prompt();
      } else
        term.writeln(
          `\x1b[90m${session.wslDistribution ? `正在启动 WSL · ${session.wslDistribution}` : `正在连接 ${session.host.username}@${session.host.address}:${session.host.port}`} …\x1b[0m\r\n`,
        );
      resize();
      const element = container.current!;
      return () => {
        disposed = true;
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
      if (terminal.current) {
        terminal.current.options.theme = terminalTheme(dark);
        terminal.current.options.fontSize = fontSize;
        terminal.current.options.lineHeight = lineHeight;
        requestFit.current();
      }
    }, [dark, fontSize, lineHeight]);
    useEffect(() => {
      if (!active) closeMenu();
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
          aria-label={`${session.host.name} 终端 #${session.terminalNumber}`}
        />
        {active && menu && (
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
