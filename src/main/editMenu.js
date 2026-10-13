// Bind actions to the contents that was clicked, not whichever guest happens
// to be focused when the native menu closes.
function editMenu(contents, params, clipboard) {
  const items = [];
  const flags = params.editFlags || {};
  const action = (label, command, enabled) => ({
    label, enabled: !!enabled,
    click: () => { if (!contents.isDestroyed()) contents[command](); },
  });
  if (params.isEditable) {
    items.push(action('Undo', 'undo', flags.canUndo), action('Redo', 'redo', flags.canRedo),
      { type: 'separator' }, action('Cut', 'cut', flags.canCut));
  }
  if (params.isEditable || params.selectionText) items.push(action('Copy', 'copy', flags.canCopy));
  if (params.isEditable) {
    items.push(action('Paste', 'paste', flags.canPaste),
      action('Select all', 'selectAll', flags.canSelectAll));
  }
  if (params.linkURL) items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
  if (params.mediaType === 'image') items.push({ label: 'Copy image', click: () => {
    if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
  } });
  return items;
}

module.exports = { editMenu };
