package io.orbitssh.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.WebView;

import org.json.JSONObject;

/** Android's floating text toolbar for xterm's canvas-backed selection. */
final class TerminalActionMode extends ActionMode.Callback2 {
    interface Listener { void onAction(String session, String action, String text); }

    private final WebView view;
    private final Listener listener;
    private final Rect anchor = new Rect();
    private ActionMode mode;
    private String session = "";
    private String selection = "";
    private boolean connected;

    TerminalActionMode(WebView view, Listener listener) {
        this.view = view;
        this.listener = listener;
    }

    void show(String nextSession, String text, JSONObject bounds, boolean canPaste) throws Exception {
        if (!session.equals(nextSession)) finish();
        session = nextSession;
        selection = text;
        connected = canPaste;
        float scale = view.getWidth() / (float) Math.max(1, bounds.getDouble("viewportWidth"));
        int x = Math.max(0, Math.min(view.getWidth() - 1, Math.round((float) bounds.getDouble("x") * scale)));
        int y = Math.max(0, Math.min(view.getHeight() - 1, Math.round((float) bounds.getDouble("y") * scale)));
        int height = Math.max(1, Math.round((float) bounds.getDouble("height") * scale));
        anchor.set(x, y, Math.min(view.getWidth(), x + Math.max(1, Math.round(24 * scale))), Math.min(view.getHeight(), y + height));
        if (mode == null) mode = view.startActionMode(this, ActionMode.TYPE_FLOATING);
        if (mode == null) throw new IllegalStateException("无法打开系统文本菜单");
        mode.invalidate();
        mode.invalidateContentRect();
    }

    void hide(String owner) {
        if (session.equals(owner)) finish();
    }

    void finish() {
        if (mode != null) mode.finish();
    }

    private ClipboardManager clipboard() {
        return (ClipboardManager) view.getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @Override public boolean onCreateActionMode(ActionMode actionMode, Menu menu) {
        menu.add(0, android.R.id.copy, 0, android.R.string.copy).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
        menu.add(0, android.R.id.paste, 1, android.R.string.paste).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
        menu.add(0, android.R.id.selectAll, 2, android.R.string.selectAll).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
        return true;
    }

    @Override public boolean onPrepareActionMode(ActionMode actionMode, Menu menu) {
        menu.findItem(android.R.id.copy).setEnabled(!selection.isEmpty());
        menu.findItem(android.R.id.paste).setEnabled(connected && clipboard().hasPrimaryClip());
        return true;
    }

    @Override public boolean onActionItemClicked(ActionMode actionMode, MenuItem item) {
        if (item.getItemId() == android.R.id.copy) {
            clipboard().setPrimaryClip(ClipData.newPlainText("Orbit SSH", selection));
            actionMode.finish();
        } else if (item.getItemId() == android.R.id.paste) {
            ClipData clip = clipboard().getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0)
                listener.onAction(session, "paste", clip.getItemAt(0).coerceToText(view.getContext()).toString());
            actionMode.finish();
        } else if (item.getItemId() == android.R.id.selectAll) {
            listener.onAction(session, "selectAll", "");
        } else return false;
        return true;
    }

    @Override public void onGetContentRect(ActionMode actionMode, View source, Rect outRect) {
        outRect.set(anchor);
    }

    @Override public void onDestroyActionMode(ActionMode actionMode) {
        mode = null;
        listener.onAction(session, "dismiss", "");
        session = "";
        selection = "";
    }
}
