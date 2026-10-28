// Account settings: Profile / Integrations / Security tabs. Data: GET /api/account
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { state } from '../../../state.js';
import { setUserAvatar } from '../../../ui.js';
import { accountGet } from './parts.jsx';
import { ProfileTab } from './ProfileTab.jsx';
import { IntegrationsTab } from './IntegrationsTab.jsx';
import { SecurityTab } from './SecurityTab.jsx';

export function AccountDialog({ onClose }) {
  const [account, setAccount] = React.useState(null);
  const [tg, setTg] = React.useState(false);

  React.useEffect(() => {
    accountGet().then((d) => {
      if (d.avatar) setUserAvatar(d.avatar);
      if (d.timezone) state.timezone = d.timezone;
      if (d.tradingLimits) state.tradingLimits = d.tradingLimits;
      setTg(!!d.tgConnected);
      setAccount(d || {});
    }).catch(() => setAccount({}));
  }, []);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
          <DialogDescription className="sr-only">Profile, integrations and security</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="profile" className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>
          {!account
            ? <div className="grid gap-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
            : <>
                <TabsContent value="profile"><ProfileTab account={account} /></TabsContent>
                <TabsContent value="integrations"><IntegrationsTab account={account} onTelegram={setTg} /></TabsContent>
                <TabsContent value="security"><SecurityTab account={account} tgConnected={tg} /></TabsContent>
              </>}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
