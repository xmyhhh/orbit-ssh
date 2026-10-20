import { Modal } from "./Modal";

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="快捷键" onClose={onClose}>
      <div className="help-shortcuts">
        <div>
          <span>快速搜索</span>
          <kbd>Ctrl / ⌘ K</kbd>
        </div>
        <div>
          <span>新建连接</span>
          <kbd>Ctrl / ⌘ T</kbd>
        </div>
        <div>
          <span>搜索终端</span>
          <kbd>Ctrl / ⌘ Shift F</kbd>
        </div>
        <div>
          <span>复制选中 / 粘贴</span>
          <kbd>Ctrl / ⌘ C / V</kbd>
        </div>
        <div>
          <span>复制 / 粘贴（终端）</span>
          <kbd>Ctrl Shift C / V</kbd>
        </div>
        <div>
          <span>全选终端</span>
          <kbd>Ctrl Shift A / ⌘ A</kbd>
        </div>
        <div>
          <span>保存文件</span>
          <kbd>Ctrl / ⌘ S</kbd>
        </div>
        <div>
          <span>终端缩放 / 复原</span>
          <kbd>Ctrl + / − / 0</kbd>
        </div>
      </div>
      <div className="modal-footer">
        <button className="button primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
