// The weekly summary sent as a notification
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function WeeklyReportDialog({ report, onClose }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Weekly summary</DialogTitle>
          <DialogDescription className="sr-only">Your week in trades</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{report || ''}</p>
      </DialogContent>
    </Dialog>
  );
}
