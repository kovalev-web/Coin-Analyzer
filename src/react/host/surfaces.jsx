// Surfaces the vanilla side can open by name (openSurface in src/react-bridge.js)
import { SearchDialog } from './SearchDialog.jsx';
import { ClearMenu } from './ClearMenu.jsx';
import { HintsDialog } from './HintsDialog.jsx';
import { WeeklyReportDialog } from './WeeklyReportDialog.jsx';
import { NotificationsPopover } from './NotificationsPopover.jsx';
import { MorningDialog } from './MorningDialog.jsx';
import { EveningDialog } from './EveningDialog.jsx';
import * as React from 'react';
import { BriefingPopover } from '../home/Briefing.jsx';
import { NotesPopover } from './NotesPopover.jsx';
import { AnalysisPopover } from './AnalysisPopover.jsx';

// Loaded on first open (QR codes, selects, code inputs — not needed for the rest)
const AccountDialog = React.lazy(() => import('./account/AccountDialog.jsx').then((m) => ({ default: m.AccountDialog })));

export const SURFACES = {
  search: SearchDialog,
  clear: ClearMenu,
  hints: HintsDialog,
  weekly: WeeklyReportDialog,
  notifications: NotificationsPopover,
  morning: MorningDialog,
  evening: EveningDialog,
  account: AccountDialog,
  briefing: BriefingPopover,
  notes: NotesPopover,
  analysis: AnalysisPopover,
};
