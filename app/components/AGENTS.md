# app/components/ — shared component library

Reusable, feature-agnostic UI used across scenes. Feature-specific components
live inside their scene (`app/scenes/<X>/components/`), not here.

## Structure

Flat `.tsx`/`.ts` files for primitives (`Button.tsx`, `Input*.ts*`, `Flex.tsx`,
`Text.ts`, `Table.tsx`, `Modal.tsx`, `Tooltip.tsx`, `Toasts.tsx`, `Lightbox.tsx`,
`Theme.tsx`, `WebsocketProvider.tsx`) plus feature folders:

`Avatar/` · `Collection/` · `CommandBar/` · `DocumentExplorer/` · `EmojiDialog/` ·
`Export/` · `HoverPreview/` · `IconPicker/` · `Icons/` · `List/` ·
`LoadingIndicator/` · `Menu/` · `Notifications/` · `OAuthClient/` · `primitives/` ·
`Reactions/` · `Sharing/` · `Sidebar/` · `SplitView/` · `Tabs/` · `Template/` ·
`TemplatizeDialog/`

## Conventions

- Function components + hooks; event handlers named `handle*`.
- styled-components only, co-located in the `.tsx`. Import from `primitives/`
  for base controls.
- Wrap in `observer()` (mobx-react) when reading stores.
- Import React only when used directly (react-jsx runtime).
- `Sidebar/` is the largest subfolder (42 files) — the app's primary nav; its
  drag-and-drop logic is in `Sidebar/hooks/useDragAndDrop.tsx` (714).

## Hot files (edit carefully)

`Lightbox.tsx` (1262) · `WebsocketProvider.tsx` (846) · `Table.tsx` (742) ·
`Sidebar/hooks/useDragAndDrop.tsx` (714) · `Sidebar/components/DocumentLink.tsx` (518)
