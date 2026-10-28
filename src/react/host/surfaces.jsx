// Surfaces the vanilla side can open by name (openSurface in src/react-bridge.js)
import { SearchDialog } from './SearchDialog.jsx';
import { ClearMenu } from './ClearMenu.jsx';
import { HintsDialog } from './HintsDialog.jsx';
import { WeeklyReportDialog } from './WeeklyReportDialog.jsx';
import { NotificationsPopover } from './NotificationsPopover.jsx';
import { MorningDialog } from './MorningDialog.jsx';
import { EveningDialog } from './EveningDialog.jsx';

export const SURFACES = {
  search: SearchDialog,
  clear: ClearMenu,
  hints: HintsDialog,
  weekly: WeeklyReportDialog,
  notifications: NotificationsPopover,
  morning: MorningDialog,
  evening: EveningDialog,
};
