// «Как читать»: a short guide to the algorithm signals and the radar — the
// trader's day with them, what the marks on the chart look like (C, P, own
// trades, notes) and what the card says, the radar's line and columns, what to
// do. Opened from «Подробнее» in the mark card and the radar.
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

// A few candles with the marks as the chart draws them
function MarksPicture() {
  const candles = [[20, 62, 70, 54, 74], [36, 60, 52, 48, 66], [52, 52, 44, 40, 56], [68, 44, 36, 30, 48], [84, 36, 40, 32, 46], [100, 40, 30, 26, 44], [116, 30, 24, 20, 34], [132, 24, 28, 20, 32]]
    .map(([x, o, c, h, l]) => [x, o + 18, c + 18, h + 18, l + 18]);
  const arrow = (x, y, dir) => `M${x},${y} l-5,${dir * 7} h3.5 v${dir * 6} h3 v${-dir * 6} h3.5 z`;
  return (
    <svg viewBox="0 0 230 112" className="h-36 w-full max-w-sm" aria-hidden>
      <g className="text-muted-foreground" stroke="currentColor" fill="currentColor">
        {candles.map(([x, o, c, h, l]) => (
          <g key={x}><line x1={x} x2={x} y1={h} y2={l} /><rect x={x - 4} y={Math.min(o, c)} width="8" height={Math.max(2, Math.abs(o - c))} /></g>
        ))}
      </g>
      {/* C — pressure (buy) where it started: arrow up under the price, letter below */}
      <g className="fill-bullish text-bullish"><path d={arrow(52, 78, 1)} /><text x="52" y="104" textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor">C</text></g>
      {/* P — a timer selling: arrow down above, letter over it */}
      <g className="fill-danger text-danger"><path d={arrow(116, 34, -1)} /><text x="116" y="16" textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor">P</text></g>
      {/* own fills: filled triangles at the price */}
      <path d="M152,58 l-8,14 h16 z" className="fill-bullish" />
      <path d="M178,48 l-8,-14 h16 z" className="fill-danger" />
      {/* note bubble */}
      <rect x="198" y="56" width="22" height="16" rx="4" className="fill-background stroke-muted-foreground" />
      <line x1="202" x2="216" y1="62" y2="62" className="stroke-muted-foreground" />
      <line x1="202" x2="212" y1="67" y2="67" className="stroke-muted-foreground" />
    </svg>
  );
}

function Rows({ rows }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}><dt className="font-medium whitespace-nowrap">{k}</dt><dd className="text-muted-foreground">{v}</dd></React.Fragment>
      ))}
    </dl>
  );
}

const H = ({ children }) => <h3 className="mt-1 text-xs font-medium text-muted-foreground uppercase">{children}</h3>;

export function AlgoGuideDialog({ onClose }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Как читать сигналы</DialogTitle>
          <DialogDescription>Боты в ленте сделок на 8 биржах и откуда ход</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="flow" className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="flow">Как пользоваться</TabsTrigger>
            <TabsTrigger value="marks">Метки</TabsTrigger>
            <TabsTrigger value="radar">Радар</TabsTrigger>
          </TabsList>

          <TabsContent value="flow" className="grid gap-3 text-sm">
            <ol className="grid list-decimal gap-1.5 pl-5">
              <li><b>Утро:</b> утренняя карточка + монеты в брифинг. С этого момента сервер слушает их сделки на Binance, Bybit, OKX (фьючерсы и спот), Hyperliquid и Upbit. После вечерней карточки — выключается.</li>
              <li><b>Ждёшь сигнал:</b> тост с «Открыть», сообщение в Telegram, значок в строке брифинга, пока бот работает:
                <span className="mt-1 flex gap-1.5"><Badge variant="outline" className="border-bullish/40 text-bullish">C · покупка · Bybit P</Badge><Badge variant="outline" className="border-danger/40 text-danger">P · продажа · Hyperliquid P</Badge></span>
              </li>
              <li><b>Открываешь график</b> → метка C или P там, где бот начал → клик — карточка.</li>
              <li><b>Не понятно, откуда ход</b> → радар (кнопка-радар над графиком).</li>
            </ol>
            <H>Что делать</H>
            <Rows rows={[
              ['Покупает, «идёт»', 'лонг по ходу, брать проливы; ориентир — его средняя цена'],
              ['Продаёт, «идёт»', 'не лонговать, шорт от отскоков'],
              ['Закончил', 'поддержки больше нет — не догонять'],
              ['Оба идут', 'борьба — ждать, кто выдохнется'],
              ['Меток нет', 'толпа или шум — работаешь только по стакану'],
            ]} />
            <p className="text-xs text-muted-foreground">Бот виден не сразу: таймер — после 5 повторов, давление — после 3 минут. Первую ногу хода метка не ловит.</p>
          </TabsContent>

          <TabsContent value="marks" className="grid gap-3">
            <MarksPicture />
            <Rows rows={[
              [<span className="text-bullish">↑C</span>, 'давление: минуты, где ≥ 70% объёма одной стороной, объём ≥ 5× и сделок ≥ 3× обычного — бот режет крупную заявку на тысячи мелких'],
              [<span className="text-danger">↓P</span>, 'таймер: одна сторона, кусок одного размера через ровные промежутки (~$80K каждые ~30 с). На Hyperliquid ровно 30 с — встроенный TWAP биржи'],
              ['Зелёная ↑ / красная ↓', 'покупка / продажа; стоит у цены, где бот начал'],
              [<span><span className="text-bullish">▲</span><span className="text-danger">▼</span></span>, 'твои исполнения (клавиша T над графиком — скрыть / показать)'],
              ['Пузырь', 'твоя заметка по монете'],
            ]} />
            <H>Карточка метки</H>
            <Rows rows={[
              ['Биржа', 'где сидит бот'],
              ['Сделок / Всего', 'сколько раз и на сколько денег'],
              ['Цена за серию', 'куда сдвинулась цена, пока он работал'],
              ['Средняя цена', 'его уровень (таймер)'],
              ['Доля в обороте', 'выше 20% — двигает цену, ниже 5% — фон (таймер)'],
              ['Замечено, «цена уже»', 'когда бота стало видно и сколько ход уже прошёл'],
              ['Конец', '«идёт» — он в рынке сейчас; «длился N мин» — ушёл'],
            ]} />
          </TabsContent>

          <TabsContent value="radar" className="grid gap-3">
            <p className="text-sm">Монета на всех биржах за 15 мин–2 ч, каждая против своей нормы (2 ч до окна). Сверху — одна строка: кто начал ход и как отстал Binance; «одновременно» — несколько бирж в одну минуту, по свечам не различить. Чипы — биржи, вышедшие из нормы.</p>
            <H>Колонки «Подробно»</H>
            <Rows rows={[
              ['Старт', 'минута, с которой 3 минуты подряд объём ≥ 3× обычного'],
              ['Лаг', 'на сколько позже первой биржи'],
              ['Объём, Сделки', 'во сколько раз больше обычной минуты'],
              ['Покупки', 'доля рыночных покупок (есть у Binance); > 55% — давят покупатели'],
              ['Кто', '«толпа» — сделки мельче обычного, «крупный» — крупнее'],
              ['Цена', 'изменение за окно'],
              ['Доля', 'доля объёма монеты сейчас / обычно: выросла — участник там'],
              ['Фьючерсы: OI', 'растёт — открывают новые позиции, падает — закрывают'],
              ['Фандинг', 'плюс — лонги платят шортам (перекос в лонг)'],
              ['Ликвидации', 'выбитые лонги / шорты на Binance за окно'],
            ]} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
