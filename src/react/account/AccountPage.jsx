// Account settings page (/settings): Profile / Integrations / Security.
// A page, not a modal — keys, passwords and 2FA get a URL of their own and
// nothing behind them. The tab is in the URL (?tab=integrations).
// Data: GET /api/account
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { state } from '../../state.js';
import { setUserAvatar } from '../../ui.js';
import { accountGet } from './parts.jsx';
import { ProfileTab } from './ProfileTab.jsx';
import { IntegrationsTab } from './IntegrationsTab.jsx';
import { SecurityTab } from './SecurityTab.jsx';

const TABS = ['profile', 'integrations', 'security'];

function tabFromUrl() {
  const t = new URLSearchParams(window.location.search).get('tab');
  return TABS.includes(t) ? t : 'profile';
}

export function AccountPage() {
  const [account, setAccount] = React.useState(null);
  const [tg, setTg] = React.useState(false);
  const [tab, setTab] = React.useState(tabFromUrl);

  React.useEffect(() => {
    accountGet().then((d) => {
      if (d.avatar) setUserAvatar(d.avatar);
      if (d.timezone) state.timezone = d.timezone;
      if (d.tradingLimits) state.tradingLimits = d.tradingLimits;
      setTg(!!d.tgConnected);
      setAccount(d || {});
    }).catch(() => setAccount({}));
  }, []);

  const pick = (t) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === 'profile') url.searchParams.delete('tab'); else url.searchParams.set('tab', t);
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="jr mx-auto w-full max-w-xl space-y-4 px-4 py-6 max-sm:px-3 max-sm:py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" asChild>
            <a href="/" aria-label="Back"><ArrowLeft /></a>
          </Button>
          <h1 className="text-lg font-semibold">Account settings</h1>
        </div>
        <Tabs value={tab} onValueChange={pick} className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>
          <Card className="py-4">
            <CardContent className="px-4 sm:px-6">
              {!account
                ? <div className="grid gap-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
                : <>
                    <TabsContent value="profile"><ProfileTab account={account} /></TabsContent>
                    <TabsContent value="integrations"><IntegrationsTab account={account} onTelegram={setTg} /></TabsContent>
                    <TabsContent value="security"><SecurityTab account={account} tgConnected={tg} /></TabsContent>
                  </>}
            </CardContent>
          </Card>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}
