import { useEffect, useRef, useState } from "react";
import { backend, errorText } from "../bridge";
import type { Directory, LocalDirectory, RemoteFile, Session } from "../types";
import type { Side } from "./fileUtils";

let lastLocalPath = "";
const remotePaths = new Map<string, string>();

function demoFile(name: string, isDir: boolean, bytes = 0): RemoteFile {
  return {
    name,
    isDir,
    size: bytes,
    isSymlink: false,
    modified: "2026-10-18T10:30:00+08:00",
    mode: isDir ? "drwxr-xr-x" : "-rw-r--r--",
  };
}
function demoListing(side: Side, requested: string): LocalDirectory {
  const home = side === "local" ? "C:\\Users\\you" : "/home/explorer";
  const path = requested || home;
  let files: RemoteFile[] = [];
  if (path === home)
    files =
      side === "local"
        ? [
            demoFile("Documents", true),
            demoFile("Downloads", true),
            demoFile("deploy.sh", false, 432),
            demoFile("README.md", false, 1840),
          ]
        : [
            demoFile("projects", true),
            demoFile("documents", true),
            demoFile(".ssh", true),
            demoFile("welcome.txt", false, 128),
            demoFile("server.log", false, 20480),
          ];
  else if (path.endsWith("projects") || path.endsWith("Documents"))
    files = [
      demoFile("app", true),
      demoFile("config.json", false, 524),
      demoFile("notes.txt", false, 218),
    ];
  else if (path === "::drives")
    files = [demoFile("C:\\", true), demoFile("D:\\", true)];
  const parent =
    path === "::drives"
      ? path
      : path.replace(/[\\/]$/, "").replace(/[\\/][^\\/]*$/, "") ||
        (side === "local" ? "::drives" : "/");
  return { path, files, parent };
}

export function useDirectory(session: Session, side: Side) {
  const [directory, setDirectory] = useState<LocalDirectory>({
    path: "",
    files: [],
    parent: "",
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const token = useRef(0);
  const alive = useRef(true);
  const latest = useRef(directory);
  latest.current = directory;
  async function load(requested = "") {
    const current = ++token.current;
    setBusy(true);
    setError("");
    try {
      let value: LocalDirectory;
      if (session.demo) value = demoListing(side, requested);
      else if (side === "local")
        value = await backend().ListLocalDirectory(requested);
      else {
        const remote: Directory = await backend().ListDirectory(
          session.id,
          requested,
        );
        value = {
          ...remote,
          parent: remote.path.replace(/\/$/, "").replace(/\/[^/]*$/, "") || "/",
        };
      }
      if (!alive.current || current !== token.current) return;
      setSelected((previous) =>
        latest.current.path === value.path
          ? previous.filter((name) =>
              value.files.some((file) => file.name === name),
            )
          : [],
      );
      setDirectory(value);
      setInput(value.path);
      if (!session.demo) {
        if (side === "local") lastLocalPath = value.path;
        else remotePaths.set(session.id, value.path);
      }
    } catch (e) {
      if (alive.current && current === token.current) setError(errorText(e));
    } finally {
      if (alive.current && current === token.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load(
      session.demo
        ? ""
        : side === "local"
          ? lastLocalPath
          : remotePaths.get(session.id) || "",
    );
    return () => {
      alive.current = false;
      token.current++;
    };
  }, [session.id, side]);
  return {
    directory,
    input,
    setInput,
    busy,
    error,
    setError,
    selected,
    setSelected,
    load,
    latest,
  };
}
export type BrowserState = ReturnType<typeof useDirectory>;
