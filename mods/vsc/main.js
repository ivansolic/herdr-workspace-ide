// Herdr Workbench: one mod, one view per layout block, chosen by props.view.
// One mod so every view shares lib/ (a mod cannot import another mod's files).
import { View } from "gpui-kit";
import { props as blockProps } from "herdr";
import Activity, { restorePanelButtons } from "./views/activity.js";
import Explorer from "./views/explorer.js";
import Search from "./views/search.js";
import QuickOpen from "./views/quickopen.js";
import Problems from "./views/problems.js";
import Menu from "./views/menu.js";
import Dialog from "./views/dialog.js";
import CompareTab from "./views/compare.js";
import FileEditor from "./views/editor.js";
import SourceControl from "./views/scm.js";
import DiffTab from "./views/diff.js";
import DiagramTab from "./views/diagram.js";
import { dropImageCopies } from "./lib/storage.js";
import { diagramPath } from "./lib/open.js";

const VIEWS = { activity: Activity, explorer: Explorer, scm: SourceControl, search: Search, problems: Problems, quickopen: QuickOpen, menu: Menu, dialog: Dialog, compare: CompareTab, editor: FileEditor, diff: DiffTab, diagram: DiagramTab };

export default class Workbench extends View {
  init(_props, cx) {
    // A layout block's content.props arrive through props(), not as init's argument.
    const p = blockProps();
    this.kind = p?.view; this.props = p;
    this.view = cx.new(VIEWS[this.kind] ?? Explorer, p);
  }

  // Called when this block goes (layout switched away, app quit): undo what the rail changed.
  async close() {
    if (this.kind === "activity") restorePanelButtons();
    if (this.kind === "editor" || this.kind === "diagram") {
      const key = this.kind === "diagram" ? diagramPath(this.props?.file, this.props?.index) : this.props?.file;
      try { await dropImageCopies(this.props?.on ?? null, key); }
      catch (e) { console.log(`vsc: could not remove image copies: ${e?.message ?? e}`); }
    }
  }

  render() {
    return this.view;
  }
}
