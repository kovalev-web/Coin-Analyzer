// Surfaces the vanilla side can open by name (openSurface in src/react-bridge.js)
import { SearchPopover } from './SearchPopover.jsx';
import { ClearMenu } from './ClearMenu.jsx';
import { HintsDialog } from './HintsDialog.jsx';
import { WeeklyReportDialog } from './WeeklyReportDialog.jsx';
import { NotificationsPopover } from './NotificationsPopover.jsx';
import { MorningDialog } from './MorningDialog.jsx';
import { EveningDialog } from './EveningDialog.jsx';
import { BriefingPopover } from '../home/Briefing.jsx';
import { NotesPopover } from './NotesPopover.jsx';
import { AnalysisPopover } from './AnalysisPopover.jsx';
import { TermSettingsDialog } from './TermSettingsDialog.jsx';
import { LiquidityPopover } from './LiquidityPopover.jsx';
import { ChartTouchMenu } from './ChartTouchMenu.jsx';
import { OriginPopover } from './OriginPopover.jsx';
import { AlgoCard } from './AlgoCard.jsx';


export const SURFACES = {
  search: SearchPopover,
  clear: ClearMenu,
  hints: HintsDialog,
  weekly: WeeklyReportDialog,
  notifications: NotificationsPopover,
  morning: MorningDialog,
  evening: EveningDialog,
  briefing: BriefingPopover,
  notes: NotesPopover,
  analysis: AnalysisPopover,
  liquidity: LiquidityPopover,
  'chart-menu': ChartTouchMenu,
  origin: OriginPopover,
  algo: AlgoCard,
  'term-settings': TermSettingsDialog,
};
