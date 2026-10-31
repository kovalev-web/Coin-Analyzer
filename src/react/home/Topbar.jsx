// Main screen header: logo (refresh), Tear / Gainers, trading sessions, and
// the actions on the right. Buttons keep their data-action so the click
// handling in main.js stays the one place for what they do.
import * as React from 'react';
import { Bell, Bookmark, BookOpen, CircleHelp, Info, LayoutGrid, LogIn, Moon, Search, Sun, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useEvents } from '@/shared/use-event';
import { useSiteTheme } from '@/shared/use-site-theme';
import { state } from '../../state.js';
import { LOGO_SVG, getUserAvatar, sessionInfo } from '../../ui.js';
import { closePopovers } from '../../react-bridge.js';

// The logo with a size class, so the button's default icon size doesn't shrink it.
// Read at render time: ui.js imports this file, so its exports aren't ready at load.
const logo = () => LOGO_SVG.replace('<svg ', '<svg class="size-7" ');

function IconAction({ label, action, className, children, ...rest }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} data-action={action} className={'max-md:size-8 ' + (className || '')} {...rest}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Asia / Europe / America: which are open (with how far along) and what's next
function Sessions({ compact }) {
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 30000); return () => clearInterval(t); }, []);
  useEvents(['timezone:changed']);
  const info = sessionInfo();
  return (
    <div className={'flex items-center gap-4 text-xs text-muted-foreground ' + (compact ? 'flex-col items-start gap-2' : '')}>
      {info.dots.length > 0 && (
        <span className="flex items-center gap-4">
          {info.dots.map((d) => (
            <Tooltip key={d.key}>
              <TooltipTrigger asChild>
                <span className={'flex items-center gap-1.5 ' + (d.ending ? '' : 'text-foreground')}>
                  <svg className="size-3.5 shrink-0" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="5" fill="none" stroke="var(--steel)" strokeWidth="3" />
                    <circle cx="7" cy="7" r="5" fill="none" stroke="var(--bullish)" strokeWidth="3" strokeDasharray={d.circ} strokeDashoffset={d.circ * (1 - d.percent)} strokeLinecap="round" transform="rotate(-90 7 7)" />
                  </svg>
                  {d.short}
                </span>
              </TooltipTrigger>
              <TooltipContent>{d.label} {d.local}</TooltipContent>
            </Tooltip>
          ))}
        </span>
      )}
      <span className={'font-medium ' + (info.dots.length && !compact ? 'border-l pl-3' : '')}>{compact ? info.nextTextShort : info.nextText}</span>
    </div>
  );
}

export function Topbar({ screener, tabs = true }) {
  useEvents(['notifications:updated', 'avatar:changed']);
  const theme = useSiteTheme();
  const demo = state.isDemoMode;
  const avatar = getUserAvatar();
  const ThemeIcon = theme === 'dark' ? Sun : Moon;

  return (
    <header className="jr relative mx-8 mt-5 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-md max-md:mx-3 max-md:mt-3 max-md:gap-1.5 max-md:px-2 max-md:py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="topbar-logo text-foreground max-md:size-8" data-action="refresh" aria-label="Refresh">
            <span className="flex" dangerouslySetInnerHTML={{ __html: logo() }} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>

      {tabs && <Tabs value={screener ? 'gainers' : 'tear'}>
        <TabsList>
          <TabsTrigger value="tear" data-action="go-main" className="px-3 max-md:px-2">Tear</TabsTrigger>
          <TabsTrigger value="gainers" data-action="go-screener" className="px-3 max-md:px-2">Gainers</TabsTrigger>
        </TabsList>
      </Tabs>}

      <div className="absolute left-1/2 hidden -translate-x-1/2 min-[901px]:block"><Sessions /></div>

      <div className="ml-auto flex items-center gap-1 max-md:gap-0">
        <IconAction label="Search  ⌘K" action="open-search"><Search /></IconAction>
        <IconAction label="Watchlist" action="open-briefing"><Bookmark /></IconAction>
        {!demo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="hidden md:inline-flex" asChild><a href="/grid" aria-label="In play"><LayoutGrid /></a></Button>
            </TooltipTrigger>
            <TooltipContent>In play</TooltipContent>
          </Tooltip>
        )}
        <IconAction label={theme === 'dark' ? 'Light theme' : 'Dark theme'} action="toggle-theme" className="hidden md:inline-flex"><ThemeIcon /></IconAction>
        {!demo && (
          <IconAction label="Notifications" action="toggle-notif" id="notif-btn" className="relative">
            <Bell />
            {state.notifUnread > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-danger ring-2 ring-card" aria-label="unread" />}
          </IconAction>
        )}
        {/* The profile menu is one of the header's popovers too: opening it closes the others */}
        <DropdownMenu onOpenChange={(o) => { if (o) closePopovers(); }}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Profile" className={'max-md:size-8 ' + (avatar ? 'text-2xl' : '')}>{avatar || <UserRound />}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {!demo && <DropdownMenuItem data-action="open-journal"><BookOpen /> Journal</DropdownMenuItem>}
            {!demo && <DropdownMenuItem asChild><a href="/grid"><LayoutGrid /> In play</a></DropdownMenuItem>}
            <DropdownMenuItem data-action="toggle-theme"><ThemeIcon /> {theme === 'dark' ? 'Light' : 'Dark'}</DropdownMenuItem>
            <DropdownMenuItem data-action="open-hints"><Info /> Interactions</DropdownMenuItem>
            <DropdownMenuItem asChild><a href="/faq"><CircleHelp /> FAQ</a></DropdownMenuItem>
            {!demo && <DropdownMenuItem data-action="open-account"><UserRound /> Account</DropdownMenuItem>}
            {demo && <DropdownMenuItem asChild><a href="/login"><LogIn /> Sign up</a></DropdownMenuItem>}
            <div className="min-[901px]:hidden">
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="font-normal"><Sessions compact /></DropdownMenuLabel>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
