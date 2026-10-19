import { ArrowUpRight, Github } from "lucide-react";
import { isDesktop } from "../bridge";
import { Modal } from "./Modal";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";
import { appVersion, projectURL } from "../appInfo";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="关于 Orbit SSH" onClose={onClose} className="about-dialog">
      <div className="about-info">
        <div className="about-version-row">
          <span>版本</span>
          <strong>v{appVersion}</strong>
        </div>
        <a
          className="about-repository-link"
          href={projectURL}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (isDesktop()) {
              event.preventDefault();
              BrowserOpenURL(projectURL);
            }
          }}
        >
          <Github size={17} aria-hidden="true" />
          <span>{projectURL.replace("https://", "")}</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
        <p className="about-license">许可协议：The Unlicense</p>
      </div>
      <div className="modal-footer">
        <button className="button primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
