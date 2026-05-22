import {
  type Dispatch,
  FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import QRCode from "qrcode";
import {
  Calculator,
  CircleDollarSign,
  Copy,
  Coins,
  Download,
  History,
  Link,
  Minus,
  Plus,
  QrCode,
  ReceiptText,
  RotateCw,
  RotateCcw,
  Settings2,
  Shuffle,
  Star,
  Trophy,
  Undo2,
  UserRound,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from "lucide-react";

type VariantId = "nanjing" | "riichi" | "qiaoma" | "sichuan" | "custom";
type WinMethod = "discard" | "self";
type EntryKind = "win" | "manual" | "riichi" | "system";
type ConnectionState = "connecting" | "connected" | "offline";
type ScreenMode = "host" | "controller" | "player";

type Player = {
  id: string;
  name: string;
  seat: string;
  marker: string;
};

type StateSnapshot = {
  riichiPot: number;
  honba: number;
  currentDealerId?: string;
  handNumber: number;
};

type LedgerEntry = {
  id: string;
  createdAt: string;
  kind: EntryKind;
  label: string;
  description: string;
  note?: string;
  deltas: Record<string, number>;
  stateBefore?: StateSnapshot;
  meta?: {
    winnerId?: string;
    method?: WinMethod | "ron" | "tsumo";
  };
};

type TableState = {
  id: string;
  createdAt: string;
  updatedAt: string;
  profileId: VariantId;
  startingScore: number;
  players: Player[];
  scores: Record<string, number>;
  ledger: LedgerEntry[];
  currentDealerId?: string;
  honba: number;
  riichiPot: number;
  handNumber: number;
};

type ProfileDefinition = {
  id: VariantId;
  name: string;
  shortName: string;
  tile: string;
  tone: string;
  defaultStartingScore: number;
  defaultUnit: number;
  quickAmounts: number[];
  chips: string[];
};

type CommonWinPayload = {
  winnerId: string;
  method: WinMethod;
  payerId: string;
  amount: number;
  base: number;
  multiplier: number;
  bonus: number;
  covered: boolean;
  note: string;
};

type RiichiPayload = {
  winnerId: string;
  winType: "ron" | "tsumo";
  payerId: string;
  ronPoints: number;
  dealerPayment: number;
  nonDealerPayment: number;
  advance: boolean;
  note: string;
};

type WinScoreKind = "multiplier" | "bonus" | "unitBonus" | "han";

type WinScoreOption = {
  id: string;
  label: string;
  detail: string;
  kind: WinScoreKind;
  value: number;
};

const STORAGE_KEY = "que-zhang-tai-state-v1";
const DEVICE_PLAYER_KEY = "que-zhang-tai-device-player-v1";
const SEATS = ["东", "南", "西", "北"];
const DEFAULT_NAMES = ["东家", "南家", "西家", "北家"];
const MARKERS = ["一万", "二筒", "三条", "红中"];

const PROFILES: ProfileDefinition[] = [
  {
    id: "nanjing",
    name: "南京麻将",
    shortName: "南京",
    tile: "南",
    tone: "jade",
    defaultStartingScore: 0,
    defaultUnit: 10,
    quickAmounts: [5, 10, 20, 40, 80],
    chips: ["花杠", "自摸", "包赔"],
  },
  {
    id: "riichi",
    name: "日本麻将",
    shortName: "日麻",
    tile: "立",
    tone: "indigo",
    defaultStartingScore: 25000,
    defaultUnit: 1000,
    quickAmounts: [1000, 2000, 3900, 8000, 12000],
    chips: ["立直", "本场", "自摸"],
  },
  {
    id: "qiaoma",
    name: "敲麻",
    shortName: "敲麻",
    tile: "敲",
    tone: "gold",
    defaultStartingScore: 0,
    defaultUnit: 10,
    quickAmounts: [10, 20, 30, 50, 100],
    chips: ["底分", "翻倍", "杠"],
  },
  {
    id: "sichuan",
    name: "四川麻将",
    shortName: "四川",
    tile: "川",
    tone: "red",
    defaultStartingScore: 0,
    defaultUnit: 5,
    quickAmounts: [5, 10, 20, 40, 80],
    chips: ["血战", "刮风", "下雨"],
  },
  {
    id: "custom",
    name: "自定义",
    shortName: "自定",
    tile: "雀",
    tone: "slate",
    defaultStartingScore: 0,
    defaultUnit: 10,
    quickAmounts: [1, 5, 10, 20, 50],
    chips: ["手动", "转账", "流水"],
  },
];

const profileMap = Object.fromEntries(
  PROFILES.map((profile) => [profile.id, profile]),
) as Record<VariantId, ProfileDefinition>;

const WIN_SCORE_OPTIONS: Record<VariantId, WinScoreOption[]> = {
  nanjing: [
    { id: "menqing", label: "门清", detail: "+20花", kind: "bonus", value: 20 },
    { id: "duiduihu", label: "对对胡", detail: "+40花", kind: "bonus", value: 40 },
    { id: "hunyi", label: "混一色", detail: "+40花", kind: "bonus", value: 40 },
    { id: "qingyi", label: "清一色", detail: "+60花", kind: "bonus", value: 60 },
    { id: "qidui", label: "七对", detail: "+40花", kind: "bonus", value: 40 },
    { id: "quanqiu", label: "全球独钓", detail: "+60花", kind: "bonus", value: 60 },
    { id: "gangkai", label: "杠后开花", detail: "+20花", kind: "bonus", value: 20 },
    { id: "qianggang", label: "抢杠胡", detail: "+20花", kind: "bonus", value: 20 },
  ],
  riichi: [
    { id: "riichi", label: "立直", detail: "1番", kind: "han", value: 1 },
    { id: "tanyao", label: "断幺九", detail: "1番", kind: "han", value: 1 },
    { id: "pinfu", label: "平和", detail: "1番", kind: "han", value: 1 },
    { id: "menzen-tsumo", label: "门前清自摸", detail: "1番", kind: "han", value: 1 },
    { id: "ippatsu", label: "一发", detail: "1番", kind: "han", value: 1 },
    { id: "yakuhai", label: "役牌", detail: "1番", kind: "han", value: 1 },
    { id: "rinshan", label: "岭上开花", detail: "1番", kind: "han", value: 1 },
    { id: "chankan", label: "抢杠", detail: "1番", kind: "han", value: 1 },
    { id: "toitoi", label: "对对和", detail: "2番", kind: "han", value: 2 },
    { id: "chiitoi", label: "七对子", detail: "2番", kind: "han", value: 2 },
    { id: "honitsu", label: "混一色", detail: "2-3番", kind: "han", value: 2 },
    { id: "chinitsu", label: "清一色", detail: "5-6番", kind: "han", value: 5 },
  ],
  qiaoma: [
    { id: "duiduihu", label: "对对胡", detail: "x2", kind: "multiplier", value: 2 },
    { id: "qingyi", label: "清一色", detail: "x4", kind: "multiplier", value: 4 },
    { id: "qidui", label: "七对", detail: "x4", kind: "multiplier", value: 4 },
    { id: "menqing", label: "门清", detail: "x2", kind: "multiplier", value: 2 },
    { id: "gangkai", label: "杠上花", detail: "x2", kind: "multiplier", value: 2 },
    { id: "qianggang", label: "抢杠胡", detail: "x2", kind: "multiplier", value: 2 },
    { id: "minggang", label: "明杠", detail: "+2底", kind: "unitBonus", value: 2 },
    { id: "angang", label: "暗杠", detail: "+4底", kind: "unitBonus", value: 4 },
  ],
  sichuan: [
    { id: "duiduihu", label: "对对胡", detail: "x2", kind: "multiplier", value: 2 },
    { id: "qingyi", label: "清一色", detail: "x4", kind: "multiplier", value: 4 },
    { id: "qidui", label: "七对", detail: "x4", kind: "multiplier", value: 4 },
    { id: "qingdui", label: "清对", detail: "x16", kind: "multiplier", value: 16 },
    { id: "longqidui", label: "龙七对", detail: "x8", kind: "multiplier", value: 8 },
    { id: "gangkai", label: "杠上花", detail: "x2", kind: "multiplier", value: 2 },
    { id: "qianggang", label: "抢杠胡", detail: "x2", kind: "multiplier", value: 2 },
    { id: "haidi", label: "海底捞月", detail: "x2", kind: "multiplier", value: 2 },
    { id: "guafeng", label: "刮风", detail: "+2底", kind: "unitBonus", value: 2 },
    { id: "xiayu", label: "下雨", detail: "+2底", kind: "unitBonus", value: 2 },
  ],
  custom: [
    { id: "duiduihu", label: "对对胡", detail: "x2", kind: "multiplier", value: 2 },
    { id: "qingyi", label: "清一色", detail: "x4", kind: "multiplier", value: 4 },
    { id: "qidui", label: "七对", detail: "x4", kind: "multiplier", value: 4 },
    { id: "gangkai", label: "杠上花", detail: "x2", kind: "multiplier", value: 2 },
    { id: "minggang", label: "明杠", detail: "+2底", kind: "unitBonus", value: 2 },
    { id: "angang", label: "暗杠", detail: "+4底", kind: "unitBonus", value: 4 },
  ],
};

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toNumber(value: string | number, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatScore(value: number) {
  return value.toLocaleString("zh-CN");
}

function formatDelta(value: number) {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatScore(value)}`;
}

function getWinOptions(profileId: VariantId) {
  return WIN_SCORE_OPTIONS[profileId] ?? WIN_SCORE_OPTIONS.custom;
}

function calculateWinScore(
  profile: ProfileDefinition,
  selectedOptionIds: string[],
  base: number,
  manualBonus: number,
) {
  const selectedOptions = getWinOptions(profile.id).filter((option) =>
    selectedOptionIds.includes(option.id),
  );
  const han = selectedOptions
    .filter((option) => option.kind === "han")
    .reduce((sum, option) => sum + option.value, 0);
  const optionMultiplier = selectedOptions
    .filter((option) => option.kind === "multiplier")
    .reduce((product, option) => product * option.value, 1);
  const hanMultiplier = han > 0 ? 2 ** han : 1;
  const cappedMultiplier =
    profile.id === "sichuan"
      ? Math.min(optionMultiplier * hanMultiplier, 16)
      : optionMultiplier * hanMultiplier;
  const flatBonus = selectedOptions
    .filter((option) => option.kind === "bonus")
    .reduce((sum, option) => sum + option.value, 0);
  const unitBonus = selectedOptions
    .filter((option) => option.kind === "unitBonus")
    .reduce((sum, option) => sum + option.value * base, 0);
  const amount = Math.max(0, base * cappedMultiplier + flatBonus + unitBonus + manualBonus);

  return {
    amount,
    flatBonus,
    han,
    multiplier: cappedMultiplier,
    selectedOptions,
    unitBonus,
  };
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function makeDeltas(players: Player[]) {
  return Object.fromEntries(players.map((player) => [player.id, 0])) as Record<
    string,
    number
  >;
}

function applyDeltas(
  scores: Record<string, number>,
  deltas: Record<string, number>,
  direction = 1,
) {
  const next = { ...scores };
  Object.entries(deltas).forEach(([playerId, delta]) => {
    next[playerId] = (next[playerId] ?? 0) + delta * direction;
  });
  return next;
}

function getSnapshot(table: TableState): StateSnapshot {
  return {
    riichiPot: table.riichiPot,
    honba: table.honba,
    currentDealerId: table.currentDealerId,
    handNumber: table.handNumber,
  };
}

function getPlayer(table: TableState, playerId: string) {
  return table.players.find((player) => player.id === playerId) ?? table.players[0];
}

function getPlayerBySeat(table: TableState, seat: string) {
  return table.players.find((player) => player.seat === seat) ?? table.players[0];
}

function getNextDealerId(table: TableState) {
  const dealer = getPlayer(
    table,
    table.currentDealerId ?? getPlayerBySeat(table, "东")?.id ?? "",
  );
  const currentSeatIndex = Math.max(0, SEATS.indexOf(dealer?.seat ?? "东"));
  const nextSeat = SEATS[(currentSeatIndex + 1) % SEATS.length];
  return getPlayerBySeat(table, nextSeat)?.id ?? table.players[0]?.id;
}

function rotateVisualSeatsClockwise(seats: string[]) {
  return seats.map((_, index) => seats[(index - 1 + seats.length) % seats.length]);
}

function getLobbySeats(rotation: number) {
  return Array.from({ length: rotation }).reduce<string[]>(
    (current) => rotateVisualSeatsClockwise(current),
    SEATS,
  );
}

function rotateTableSeatsClockwise(table: TableState): TableState {
  const currentSeats = table.players.map((player) => player.seat);
  const nextSeats = rotateVisualSeatsClockwise(currentSeats);
  const nextPlayers = table.players.map((player, index) => {
    const nextSeat = nextSeats[index] ?? player.seat;
    const hasDefaultSeatName =
      DEFAULT_NAMES.includes(player.name) || player.name === `${player.seat}家`;

    return {
      ...player,
      name: hasDefaultSeatName ? `${nextSeat}家` : player.name,
      seat: nextSeat,
    };
  });
  const eastPlayer = nextPlayers.find((player) => player.seat === "东") ?? nextPlayers[0];

  return {
    ...table,
    updatedAt: new Date().toISOString(),
    players: nextPlayers,
    currentDealerId: eastPlayer?.id,
  };
}

function loadStoredTable() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TableState;
    if (!parsed?.players?.length || !parsed?.scores) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadDevicePlayerId() {
  try {
    return localStorage.getItem(DEVICE_PLAYER_KEY) ?? "";
  } catch {
    return "";
  }
}

function isTableState(value: unknown): value is TableState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TableState>;
  return Boolean(
    typeof candidate.id === "string" &&
      Array.isArray(candidate.players) &&
      candidate.players.length >= 2 &&
      candidate.scores &&
      typeof candidate.scores === "object" &&
      Array.isArray(candidate.ledger),
  );
}

function makeEntry(
  table: TableState,
  entry: Omit<LedgerEntry, "id" | "createdAt" | "stateBefore">,
): LedgerEntry {
  return {
    ...entry,
    id: uid(),
    createdAt: new Date().toISOString(),
    stateBefore: getSnapshot(table),
  };
}

function csvCell(value: string | number) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportTable(table: TableState) {
  const headers = [
    "时间",
    "类型",
    "摘要",
    "说明",
    ...table.players.map((player) => player.name),
    "备注",
  ];
  const rows = table.ledger
    .slice()
    .reverse()
    .map((entry) => [
      formatDateTime(entry.createdAt),
      entry.kind,
      entry.label,
      entry.description,
      ...table.players.map((player) => entry.deltas[player.id] ?? 0),
      entry.note ?? "",
    ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((item) => csvCell(item)).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `雀账台-${profileMap[table.profileId].shortName}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getBrowserOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function withViewParam(url: string, view: ScreenMode) {
  try {
    const nextUrl = new URL(url, getBrowserOrigin());
    nextUrl.searchParams.set("view", view);
    return nextUrl.toString();
  } catch {
    return url;
  }
}

function getInitialScreenMode(): ScreenMode {
  if (typeof window === "undefined") return "player";
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") ?? params.get("mode");
  if (view === "host" || view === "display") return "host";
  if (view === "controller" || view === "control" || view === "admin") {
    return "controller";
  }
  if (view === "player" || view === "phone" || view === "me") return "player";
  return window.matchMedia("(min-width: 900px)").matches ? "host" : "player";
}

function useScreenMode() {
  const [screenMode, setScreenMode] = useState<ScreenMode>(getInitialScreenMode);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get("view") ?? params.get("mode");
    if (forced) return;

    const query = window.matchMedia("(min-width: 900px)");
    const update = () => setScreenMode(query.matches ? "host" : "player");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return screenMode;
}

function useQrCode(value: string) {
  const [source, setSource] = useState("");

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
      color: {
        dark: "#17211f",
        light: "#ffffff",
      },
    }).then((nextSource) => {
      if (!cancelled) setSource(nextSource);
    });

    return () => {
      cancelled = true;
    };
  }, [value]);

  return source;
}

function useScoreSound(signal: string | undefined, enabled: boolean) {
  const previousSignal = useRef(signal);

  useEffect(() => {
    if (!signal || previousSignal.current === signal) return;
    previousSignal.current = signal;
    if (!enabled) return;

    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
  }, [enabled, signal]);
}

function useSharedTable() {
  const [table, setTable] = useState<TableState | null>(() => loadStoredTable());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [shareUrls, setShareUrls] = useState<string[]>(() => [getBrowserOrigin()]);
  const socketRef = useRef<Socket | null>(null);
  const tableRef = useRef<TableState | null>(table);
  const remoteUpdateRef = useRef(false);

  useEffect(() => {
    tableRef.current = table;
  }, [table]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/network")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { urls?: string[] } | null) => {
        if (cancelled || !payload?.urls?.length) return;
        setShareUrls(payload.urls);
      })
      .catch(() => {
        setShareUrls([getBrowserOrigin()]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const socket = io({
      timeout: 1800,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    const applyRemoteTable = (nextTable: TableState | null) => {
      if (!tableRef.current && !nextTable) {
        remoteUpdateRef.current = false;
        setTable(null);
        return;
      }
      remoteUpdateRef.current = true;
      tableRef.current = nextTable;
      setTable(nextTable);
    };

    socket.on("connect", () => {
      setConnection("connected");
    });

    socket.on("connect_error", () => {
      setConnection("offline");
    });

    socket.on("disconnect", () => {
      setConnection("offline");
    });

    socket.on("table:init", (serverTable: unknown) => {
      setConnection("connected");
      if (isTableState(serverTable)) {
        applyRemoteTable(serverTable);
        return;
      }

      applyRemoteTable(null);
    });

    socket.on("table:update", (serverTable: unknown) => {
      if (isTableState(serverTable)) {
        applyRemoteTable(serverTable);
      }
    });

    socket.on("table:clear", () => {
      applyRemoteTable(null);
    });

    const offlineTimer = window.setTimeout(() => {
      if (!socket.connected) setConnection("offline");
    }, 2200);

    return () => {
      window.clearTimeout(offlineTimer);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    tableRef.current = table;
    if (table) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }

    if (remoteUpdateRef.current) {
      remoteUpdateRef.current = false;
      return;
    }

    const socket = socketRef.current;
    if (!socket?.connected) return;
    if (table) {
      socket.emit("table:set", table);
    } else {
      socket.emit("table:clear");
    }
  }, [table]);

  return {
    table,
    setTable,
    connection,
    shareUrls,
  };
}

export default function App() {
  const { table, setTable, connection, shareUrls } = useSharedTable();
  const screenMode = useScreenMode();
  const [selectedPlayerId, setSelectedPlayerId] = useState(loadDevicePlayerId);

  useEffect(() => {
    try {
      if (selectedPlayerId) {
        localStorage.setItem(DEVICE_PLAYER_KEY, selectedPlayerId);
      } else {
        localStorage.removeItem(DEVICE_PLAYER_KEY);
      }
    } catch {
      // Some mobile browsers can deny local storage in private mode.
    }
  }, [selectedPlayerId]);

  useEffect(() => {
    if (!table || !selectedPlayerId) return;
    const stillExists = table.players.some((player) => player.id === selectedPlayerId);
    if (!stillExists) setSelectedPlayerId("");
  }, [selectedPlayerId, table]);

  const commit = (
    recipe: (current: TableState) => {
      entry: LedgerEntry;
      patch?: Partial<TableState>;
    },
  ) => {
    setTable((current) => {
      if (!current) return current;
      const { entry, patch } = recipe(current);
      return {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        scores: applyDeltas(current.scores, entry.deltas),
        ledger: [entry, ...current.ledger],
      };
    });
  };

  const handleCommonWin = (payload: CommonWinPayload) => {
    commit((current) => {
      const deltas = makeDeltas(current.players);
      const winner = getPlayer(current, payload.winnerId);
      const payer = getPlayer(current, payload.payerId);
      const opponents = current.players.filter((player) => player.id !== winner.id);

      if (payload.method === "self") {
        opponents.forEach((player) => {
          deltas[player.id] -= payload.amount;
          deltas[winner.id] += payload.amount;
        });
      } else {
        const paid = payload.covered
          ? payload.amount * Math.max(1, opponents.length)
          : payload.amount;
        deltas[payer.id] -= paid;
        deltas[winner.id] += paid;
      }

      const label =
        payload.method === "self"
          ? `${winner.name} 自摸`
          : `${winner.name} 胡 ${payer.name}`;
      const description = `底 ${payload.base} x ${payload.multiplier} + ${payload.bonus} = ${payload.amount}`;

      return {
        entry: makeEntry(current, {
          kind: "win",
          label,
          description,
          note: payload.note,
          deltas,
          meta: {
            winnerId: winner.id,
            method: payload.method,
          },
        }),
      };
    });
  };

  const handleManualEntry = (
    label: string,
    description: string,
    deltas: Record<string, number>,
    note?: string,
  ) => {
    commit((current) => ({
      entry: makeEntry(current, {
        kind: "manual",
        label,
        description,
        note,
        deltas,
      }),
    }));
  };

  const handleRiichiDeclaration = (playerId: string) => {
    commit((current) => {
      const player = getPlayer(current, playerId);
      const deltas = makeDeltas(current.players);
      deltas[player.id] = -1000;

      return {
        entry: makeEntry(current, {
          kind: "riichi",
          label: `${player.name} 立直`,
          description: "立直棒 +1",
          deltas,
        }),
        patch: {
          riichiPot: current.riichiPot + 1000,
        },
      };
    });
  };

  const handleRiichiSettle = (payload: RiichiPayload) => {
    commit((current) => {
      const deltas = makeDeltas(current.players);
      const winner = getPlayer(current, payload.winnerId);
      const dealerId = current.currentDealerId ?? current.players[0].id;
      const winnerIsDealer = winner.id === dealerId;
      const honbaRonBonus = current.honba * 300;
      const honbaTsumoBonus = current.honba * 100;

      if (payload.winType === "ron") {
        const payer = getPlayer(current, payload.payerId);
        const paid = payload.ronPoints + honbaRonBonus;
        deltas[payer.id] -= paid;
        deltas[winner.id] += paid + current.riichiPot;
      } else {
        current.players
          .filter((player) => player.id !== winner.id)
          .forEach((player) => {
            const basePayment = winnerIsDealer
              ? payload.dealerPayment
              : player.id === dealerId
                ? payload.dealerPayment
                : payload.nonDealerPayment;
            const paid = basePayment + honbaTsumoBonus;
            deltas[player.id] -= paid;
            deltas[winner.id] += paid;
          });
        deltas[winner.id] += current.riichiPot;
      }

      const nextDealerId =
        payload.advance && !winnerIsDealer
          ? getNextDealerId(current)
          : current.currentDealerId;
      const nextHonba = payload.advance
        ? winnerIsDealer
          ? current.honba + 1
          : 0
        : current.honba;
      const nextHandNumber = payload.advance
        ? current.handNumber + 1
        : current.handNumber;

      return {
        entry: makeEntry(current, {
          kind: "riichi",
          label:
            payload.winType === "ron"
              ? `${winner.name} 荣和`
              : `${winner.name} 自摸`,
          description:
            payload.winType === "ron"
              ? `荣和 ${payload.ronPoints} / 本场 ${honbaRonBonus} / 立直棒 ${current.riichiPot}`
              : `自摸 ${payload.dealerPayment}/${payload.nonDealerPayment} / 本场 ${honbaTsumoBonus} / 立直棒 ${current.riichiPot}`,
          note: payload.note,
          deltas,
          meta: {
            winnerId: winner.id,
            method: payload.winType,
          },
        }),
        patch: {
          riichiPot: 0,
          honba: nextHonba,
          currentDealerId: nextDealerId,
          handNumber: nextHandNumber,
        },
      };
    });
  };

  const rotateDealer = () => {
    commit((current) => {
      const nextDealerId = getNextDealerId(current);
      const nextDealer = getPlayer(current, nextDealerId);
      return {
        entry: makeEntry(current, {
          kind: "system",
          label: "换庄",
          description: `${nextDealer.name} 坐庄`,
          deltas: makeDeltas(current.players),
        }),
        patch: {
          currentDealerId: nextDealerId,
          handNumber: current.handNumber + 1,
        },
      };
    });
  };

  const setDealer = (dealerId: string) => {
    commit((current) => {
      const dealer = getPlayer(current, dealerId);
      return {
        entry: makeEntry(current, {
          kind: "system",
          label: "指定庄家",
          description: `${dealer.name} 坐庄`,
          deltas: makeDeltas(current.players),
        }),
        patch: {
          currentDealerId: dealer.id,
        },
      };
    });
  };

  const rotateSeats = () => {
    setTable((current) => (current ? rotateTableSeatsClockwise(current) : current));
  };

  const changeHonba = (step: number) => {
    commit((current) => {
      const nextHonba = Math.max(0, current.honba + step);
      return {
        entry: makeEntry(current, {
          kind: "system",
          label: "本场",
          description: `${current.honba} -> ${nextHonba}`,
          deltas: makeDeltas(current.players),
        }),
        patch: {
          honba: nextHonba,
        },
      };
    });
  };

  const undoLast = () => {
    setTable((current) => {
      if (!current || current.ledger.length === 0) return current;
      const [entry, ...rest] = current.ledger;
      return {
        ...current,
        ...(entry.stateBefore ?? {}),
        updatedAt: new Date().toISOString(),
        scores: applyDeltas(current.scores, entry.deltas, -1),
        ledger: rest,
      };
    });
  };

  const resetScores = () => {
    setTable((current) => {
      if (!current) return current;
      const ok = window.confirm("重置分数和流水？");
      if (!ok) return current;
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        scores: Object.fromEntries(
          current.players.map((player) => [player.id, current.startingScore]),
        ),
        ledger: [],
        riichiPot: 0,
        honba: 0,
        handNumber: 1,
        currentDealerId: getPlayerBySeat(current, "东")?.id ?? current.players[0]?.id,
      };
    });
  };

  const endTable = () => {
    const ok = window.confirm("结束当前牌桌并新开一桌？");
    if (ok) {
      setSelectedPlayerId("");
      setTable(null);
    }
  };

  if (screenMode === "host") {
    return (
      <HostScreen
        connection={connection}
        shareUrls={shareUrls}
        table={table}
      />
    );
  }

  if (screenMode === "player") {
    return (
      <PlayerScreen
        connection={connection}
        selectedPlayerId={selectedPlayerId}
        shareUrls={shareUrls}
        table={table}
        onCommonWin={handleCommonWin}
        onEndTable={endTable}
        onManualEntry={handleManualEntry}
        onSelect={setSelectedPlayerId}
        onRotateSeats={rotateSeats}
        onSetDealer={setDealer}
        onStart={setTable}
      />
    );
  }

  if (!table) {
    return (
      <SetupScreen
        connection={connection}
        onStart={setTable}
        shareUrls={shareUrls}
      />
    );
  }

  const profile = profileMap[table.profileId];

  return (
    <main className="app-shell">
      <AppHeader
        profile={profile}
        table={table}
        connection={connection}
        shareUrls={shareUrls}
        onExport={() => exportTable(table)}
        onNewTable={endTable}
        onUndo={undoLast}
      />

      <PersonalScoreBar
        selectedPlayerId={selectedPlayerId}
        table={table}
        onSelect={setSelectedPlayerId}
      />

      <Scoreboard table={table} selectedPlayerId={selectedPlayerId} />

      <section className="workspace">
        <div className="primary-column">
          <CommonWinForm
            table={table}
            profile={profile}
            preferredPlayerId={selectedPlayerId}
            onSubmit={handleCommonWin}
          />

          {table.profileId === "riichi" && (
            <RiichiPanel
              table={table}
              preferredPlayerId={selectedPlayerId}
              onDeclare={handleRiichiDeclaration}
              onSettle={handleRiichiSettle}
              onRotateDealer={rotateDealer}
              onSetDealer={setDealer}
              onChangeHonba={changeHonba}
            />
          )}

          <GiveScoreForm
            selectedPlayerId={selectedPlayerId}
            table={table}
            onSubmit={handleManualEntry}
          />

          <ManualEntryForm table={table} onSubmit={handleManualEntry} />
        </div>

        <aside className="side-column">
          <NetworkPanel connection={connection} shareUrls={shareUrls} />
          <TablePanel
            table={table}
            profile={profile}
            onReset={resetScores}
            onRotateDealer={rotateDealer}
            onRotateSeats={rotateSeats}
            onSetDealer={setDealer}
          />
          <HistoryPanel table={table} onUndo={undoLast} />
        </aside>
      </section>
    </main>
  );
}

function HostScreen({
  connection,
  shareUrls,
  table,
}: {
  connection: ConnectionState;
  shareUrls: string[];
  table: TableState | null;
}) {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const latestEntry = table?.ledger[0];
  useScoreSound(latestEntry?.id, soundEnabled);

  const baseShareUrl = shareUrls[0] ?? getBrowserOrigin();
  const playerUrl = withViewParam(baseShareUrl, "player");
  const controllerUrl = withViewParam(baseShareUrl, "controller");
  const profile = table ? profileMap[table.profileId] : null;
  const dealer = table
    ? getPlayer(table, table.currentDealerId ?? table.players[0].id)
    : null;
  const totalScore =
    table?.players.reduce((sum, player) => sum + (table.scores[player.id] ?? 0), 0) ??
    0;

  return (
    <main className={`host-screen ${table ? "active" : "waiting"}`}>
      <section className="host-topbar">
        <div className="brand-block">
          <span className={`brand-mark tone-${profile?.tone ?? "jade"}`}>
            {profile?.tile ?? "雀"}
          </span>
          <div>
            <div className="brand-title">雀账台</div>
            <div className="brand-meta">
              {table ? `${profile?.name} · ${formatDateTime(table.createdAt)}` : "等待总控开局"}
            </div>
          </div>
        </div>

        <div className="host-link-block">
          <ConnectionBadge connection={connection} />
          <div className="host-url">
            <span>玩家扫码看自己的分</span>
            <strong>{playerUrl.replace(/^https?:\/\//, "")}</strong>
            <em>总控 {controllerUrl.replace(/^https?:\/\//, "")}</em>
          </div>
        </div>

        <QrCard value={playerUrl} />

        <button
          className="sound-toggle"
          onClick={() => setSoundEnabled((current) => !current)}
          type="button"
        >
          {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
          {soundEnabled ? "音效开" : "启用音效"}
        </button>
      </section>

      {!table ? (
        <section className="host-waiting">
          <div className="host-waiting-copy">
            <h1>扫码加入牌桌</h1>
            <p>玩家扫码选择自己看分；总控页负责开局、改庄和录入。</p>
          </div>
          <div className="host-rule-strip">
            {PROFILES.filter((profileItem) => profileItem.id !== "custom").map(
              (profileItem) => (
                <span className={`profile-chip ${profileItem.tone}`} key={profileItem.id}>
                  {profileItem.tile} {profileItem.shortName}
                </span>
              ),
            )}
          </div>
          <TileAnimation />
        </section>
      ) : (
        <>
          <section className="host-metrics">
            <div>
              <span>当前庄家</span>
              <strong>{dealer?.name ?? "-"}</strong>
            </div>
            <div>
              <span>局数</span>
              <strong>{table.handNumber}</strong>
            </div>
            <div>
              <span>总分</span>
              <strong>{formatScore(totalScore + table.riichiPot)}</strong>
            </div>
            <div>
              <span>立直棒/池</span>
              <strong>{formatScore(table.riichiPot)}</strong>
            </div>
          </section>

          <HostMahjongTable table={table} latestEntryId={latestEntry?.id} />

          <section className="host-event-banner" key={latestEntry?.id ?? "empty"}>
            {latestEntry ? (
              <>
                <span>{formatDateTime(latestEntry.createdAt)}</span>
                <strong>{latestEntry.label}</strong>
                <p>{latestEntry.description}</p>
              </>
            ) : (
              <>
                <span>READY</span>
                <strong>对局已开始</strong>
                <p>手机端录入胡牌、给分和庄家设置。</p>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function QrCard({ value }: { value: string }) {
  const qrSource = useQrCode(value);

  return (
    <div className="qr-card">
      <QrCode size={18} />
      {qrSource ? <img alt="个人记分页二维码" src={qrSource} /> : <span>生成中</span>}
    </div>
  );
}

function PlayerScreen({
  connection,
  selectedPlayerId,
  shareUrls,
  table,
  onCommonWin,
  onEndTable,
  onManualEntry,
  onSelect,
  onRotateSeats,
  onSetDealer,
  onStart,
}: {
  connection: ConnectionState;
  selectedPlayerId: string;
  shareUrls: string[];
  table: TableState | null;
  onCommonWin: (payload: CommonWinPayload) => void;
  onEndTable: () => void;
  onManualEntry: (
    label: string,
    description: string,
    deltas: Record<string, number>,
    note?: string,
  ) => void;
  onSelect: (playerId: string) => void;
  onRotateSeats: () => void;
  onSetDealer: (playerId: string) => void;
  onStart: Dispatch<SetStateAction<TableState | null>>;
}) {
  const playerUrl = withViewParam(shareUrls[0] ?? getBrowserOrigin(), "player");

  if (!table) {
    return (
      <PlayerLobbyScreen
        connection={connection}
        playerUrl={playerUrl}
        onSelect={onSelect}
        onStart={onStart}
      />
    );
  }

  const profile = profileMap[table.profileId];
  const selectedPlayer = table.players.find((player) => player.id === selectedPlayerId);
  const dealer = getPlayer(table, table.currentDealerId ?? table.players[0].id);
  const rankedPlayers = table.players
    .slice()
    .sort((a, b) => (table.scores[b.id] ?? 0) - (table.scores[a.id] ?? 0));
  const rank = selectedPlayer
    ? rankedPlayers.findIndex((player) => player.id === selectedPlayer.id) + 1
    : 0;
  const score = selectedPlayer ? table.scores[selectedPlayer.id] ?? 0 : 0;
  const delta = score - table.startingScore;
  const lastDelta = selectedPlayer ? table.ledger[0]?.deltas[selectedPlayer.id] ?? 0 : 0;
  const isDealer = selectedPlayer?.id === dealer.id;
  const recentEntries = table.ledger.slice(0, 5);

  return (
    <main className={`player-screen ${selectedPlayer ? "joined" : "pick"}`}>
      <header className="player-header">
        <div className="brand-block">
          <span className={`brand-mark tone-${profile.tone}`}>{profile.tile}</span>
          <div>
            <div className="brand-title">我的牌桌</div>
            <div className="brand-meta">
              {profile.name} · 庄家 {dealer.name}
            </div>
          </div>
        </div>
        <ConnectionBadge connection={connection} />
      </header>

      {!selectedPlayer && (
        <section className="player-picker">
          <label className="field-stack">
            <span>我是谁</span>
            <select
              value={selectedPlayerId}
              onChange={(event) => onSelect(event.target.value)}
            >
              <option value="">选择自己</option>
              {table.players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {selectedPlayer ? (
        <>
          <section className="player-hero-layout">
            <section className={`my-score-card ${isDealer ? "dealer" : ""}`}>
              <div className="my-score-top">
                <span>{selectedPlayer.seat}位</span>
                <strong>{isDealer ? "我是庄" : `庄家 ${dealer.name}`}</strong>
              </div>
              <h1>{selectedPlayer.name}</h1>
              <div className="my-score-number">{formatScore(score)}</div>
              <div className="my-score-meta">
                <span>第 {rank}</span>
                <span className={delta >= 0 ? "positive-text" : "negative-text"}>
                  总变化 {formatDelta(delta)}
                </span>
                <span className={lastDelta >= 0 ? "positive-text" : "negative-text"}>
                  本手 {formatDelta(lastDelta)}
                </span>
              </div>
            </section>

            <PlayerMahjongTable
              profile={profile}
              selectedPlayerId={selectedPlayer.id}
              table={table}
              onWinSubmit={onCommonWin}
              onSelect={onSelect}
              onRotateSeats={onRotateSeats}
            />
          </section>

          <section className="player-summary-grid">
            <div>
              <span>当前庄家</span>
              <strong>{dealer.name}</strong>
            </div>
            <div>
              <span>局数</span>
              <strong>{table.handNumber}</strong>
            </div>
            <div>
              <span>本场/池</span>
              <strong>
                {table.honba} / {formatScore(table.riichiPot)}
              </strong>
            </div>
          </section>

          <section className="player-rank-list">
            {rankedPlayers.map((player, index) => {
              const playerScore = table.scores[player.id] ?? 0;
              return (
                <div
                  className={player.id === selectedPlayer.id ? "selected" : ""}
                  key={player.id}
                >
                  <span>{index + 1}</span>
                  <strong>{player.name}</strong>
                  <em>{formatScore(playerScore)}</em>
                  {player.id === dealer.id && <b>庄</b>}
                </div>
              );
            })}
          </section>

          <section className="player-history">
            <h2>最近变化</h2>
            {recentEntries.length === 0 ? (
              <p>暂无流水</p>
            ) : (
              recentEntries.map((entry) => {
                const entryDelta = entry.deltas[selectedPlayer.id] ?? 0;
                return (
                  <article key={entry.id}>
                    <span>{formatDateTime(entry.createdAt)}</span>
                    <strong>{entry.label}</strong>
                    <em className={entryDelta >= 0 ? "positive-text" : "negative-text"}>
                      {formatDelta(entryDelta)}
                    </em>
                  </article>
                );
              })
            )}
          </section>

          <section className="player-action-stack">
            <div className="section-heading">
              <Settings2 size={18} />
              <h2>更多操作</h2>
            </div>

            <GiveScoreForm
              selectedPlayerId={selectedPlayer.id}
              table={table}
              onSubmit={onManualEntry}
            />

            <DealerQuickPanel
              table={table}
              onSetDealer={onSetDealer}
            />

            <div className="end-round-panel">
              <button className="danger-action" onClick={onEndTable} type="button">
                <RotateCcw size={18} />
                结束当前对局
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
          <PlayerMahjongTable
            table={table}
            onSelect={onSelect}
            onRotateSeats={onRotateSeats}
          />
          <section className="player-unselected">
            <UserRound size={42} />
            <h1>点座位进入</h1>
            <p>选完以后，这台手机只突出显示你的分数、排名和是不是庄。</p>
          </section>
        </>
      )}
    </main>
  );
}

function PlayerLobbyScreen({
  connection,
  playerUrl,
  onSelect,
  onStart,
}: {
  connection: ConnectionState;
  playerUrl: string;
  onSelect: (playerId: string) => void;
  onStart: Dispatch<SetStateAction<TableState | null>>;
}) {
  const [profileId, setProfileId] = useState<VariantId>("nanjing");
  const [seatRotation, setSeatRotation] = useState(0);
  const profile = profileMap[profileId];
  const lobbySeats = getLobbySeats(seatRotation);

  const startAtSeat = (seatIndex: number) => {
    const players = lobbySeats.map((seat, index) => ({
      id: uid(),
      name: `${seat}家`,
      seat,
      marker: MARKERS[index] ?? `${index + 1}`,
    }));
    const dealer = players.find((player) => player.seat === "东") ?? players[0];
    const now = new Date().toISOString();
    const table: TableState = {
      id: uid(),
      createdAt: now,
      updatedAt: now,
      profileId,
      startingScore: profile.defaultStartingScore,
      players,
      scores: Object.fromEntries(
        players.map((player) => [player.id, profile.defaultStartingScore]),
      ),
      ledger: [],
      currentDealerId: dealer?.id,
      honba: 0,
      riichiPot: 0,
      handNumber: 1,
    };

    onStart(table);
    onSelect(players[seatIndex]?.id ?? players[0]?.id ?? "");
  };

  return (
    <main className="player-screen lobby">
      <header className="player-header">
        <div className="brand-block">
          <span className={`brand-mark tone-${profile.tone}`}>{profile.tile}</span>
          <div>
            <div className="brand-title">雀账台</div>
            <div className="brand-meta">扫码入座</div>
          </div>
        </div>
        <ConnectionBadge connection={connection} />
      </header>

      <section className="lobby-rules">
        <h1>选择麻将</h1>
        <div className="lobby-rule-grid">
          {PROFILES.filter((item) => item.id !== "custom").map((item) => (
            <button
              className={`lobby-rule ${item.tone} ${
                item.id === profileId ? "selected" : ""
              }`}
              key={item.id}
              onClick={() => setProfileId(item.id)}
              type="button"
            >
              <span className="profile-tile">{item.tile}</span>
              <strong>{item.name}</strong>
              <small>{item.chips.join(" / ")}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="lobby-table-section">
        <div className="section-heading">
          <Users size={18} />
          <h2>选择座位</h2>
          <button
            className="icon-action small"
            onClick={() => setSeatRotation((current) => (current + 1) % SEATS.length)}
            title="东西南北顺时针转一位"
            type="button"
          >
            <RotateCw size={16} />
          </button>
        </div>
        <LobbyMahjongTable profile={profile} seats={lobbySeats} onSeat={startAtSeat} />
      </section>

      <section className="player-wait-card compact">
        <span>当前链接</span>
        <code>{playerUrl.replace(/^https?:\/\//, "")}</code>
      </section>
    </main>
  );
}

function LobbyMahjongTable({
  profile,
  seats,
  onSeat,
}: {
  profile: ProfileDefinition;
  seats: string[];
  onSeat: (seatIndex: number) => void;
}) {
  return (
    <div className="mahjong-table-board lobby-board">
      <div className="table-felt">
        <strong>{profile.shortName}</strong>
        <span>点击座位加入</span>
      </div>
      {seats.map((seat, index) => (
        <button
          className={`table-seat seat-${index}`}
          key={`${seat}-${index}`}
          onClick={() => onSeat(index)}
          type="button"
        >
          <span>{seat}</span>
          <strong>{seat}家</strong>
          <em>{seat === "东" ? "默认庄" : "空位"}</em>
        </button>
      ))}
    </div>
  );
}

function PlayerMahjongTable({
  onRotateSeats,
  onWinSubmit,
  profile,
  selectedPlayerId,
  table,
  onSelect,
}: {
  onRotateSeats?: () => void;
  onWinSubmit?: (payload: CommonWinPayload) => void;
  profile?: ProfileDefinition;
  selectedPlayerId?: string;
  table: TableState;
  onSelect: (playerId: string) => void;
}) {
  const activeProfile = profile ?? profileMap[table.profileId];
  const [winnerId, setWinnerId] = useState(selectedPlayerId ?? table.players[0]?.id ?? "");
  const [method, setMethod] = useState<WinMethod>("discard");
  const [payerId, setPayerId] = useState(
    table.players.find((player) => player.id !== selectedPlayerId)?.id ??
      table.players[1]?.id ??
      "",
  );
  const [base, setBase] = useState(String(activeProfile.defaultUnit));
  const [manualBonus, setManualBonus] = useState("0");
  const [covered, setCovered] = useState(false);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const canReportWin = Boolean(selectedPlayerId && onWinSubmit);
  const validPayers = table.players.filter((player) => player.id !== winnerId);
  const activePayerId =
    validPayers.some((player) => player.id === payerId) && payerId !== winnerId
      ? payerId
      : validPayers[0]?.id;
  const scorePreview = calculateWinScore(
    activeProfile,
    selectedOptionIds,
    Math.max(0, toNumber(base, activeProfile.defaultUnit)),
    toNumber(manualBonus, 0),
  );

  useEffect(() => {
    if (!selectedPlayerId) return;
    setWinnerId(selectedPlayerId);
    setPayerId(
      table.players.find((player) => player.id !== selectedPlayerId)?.id ??
        table.players[0]?.id ??
        "",
    );
  }, [selectedPlayerId, table.id, table.players]);

  useEffect(() => {
    setBase(String(activeProfile.defaultUnit));
    setManualBonus("0");
    setCovered(false);
    setSelectedOptionIds([]);
    setNote("");
  }, [activeProfile.defaultUnit, activeProfile.id, table.id]);

  const toggleOption = (optionId: string) => {
    setSelectedOptionIds((current) =>
      current.includes(optionId)
        ? current.filter((item) => item !== optionId)
        : [...current, optionId],
    );
  };

  const reportWin = () => {
    if (!onWinSubmit || !winnerId || scorePreview.amount <= 0) return;
    const optionText = scorePreview.selectedOptions.map((option) => option.label).join("、");
    const parts = [
      optionText || "平胡",
      scorePreview.han > 0 ? `${scorePreview.han}番` : "",
      scorePreview.multiplier !== 1 ? `x${scorePreview.multiplier}` : "",
      scorePreview.flatBonus ? `加${scorePreview.flatBonus}` : "",
      scorePreview.unitBonus ? `杠/底加${scorePreview.unitBonus}` : "",
    ].filter(Boolean);

    onWinSubmit({
      winnerId,
      method,
      payerId: activePayerId ?? winnerId,
      amount: scorePreview.amount,
      base: Math.max(0, toNumber(base, activeProfile.defaultUnit)),
      multiplier: scorePreview.multiplier,
      bonus: scorePreview.flatBonus + scorePreview.unitBonus + toNumber(manualBonus, 0),
      covered,
      note: [parts.join(" / "), note].filter(Boolean).join("；"),
    });
    setNote("");
  };

  return (
    <section className="player-table-panel">
      <div className="section-heading">
        <Users size={18} />
        <h2>麻将桌</h2>
        {onRotateSeats && (
          <button
            className="icon-action small"
            onClick={onRotateSeats}
            title="东西南北顺时针转一位"
            type="button"
          >
            <RotateCw size={16} />
          </button>
        )}
      </div>
      <div className="mahjong-table-board compact-board">
        <div className="table-felt">
          <strong>{profileMap[table.profileId].shortName}</strong>
          <span>第 {table.handNumber} 局</span>
        </div>
        {table.players.map((player, index) => {
          const score = table.scores[player.id] ?? 0;
          const isDealer = player.id === table.currentDealerId;
          const isSelected = player.id === selectedPlayerId;
          const isWinner = player.id === winnerId;
          const isPayer = method === "discard" && player.id === activePayerId;
          return (
            <article
              className={`table-seat seat-${index} ${isSelected ? "selected" : ""} ${
                isDealer ? "dealer" : ""
              } ${isWinner ? "winner" : ""} ${isPayer ? "payer" : ""}`}
              key={player.id}
            >
              <button
                className="seat-main"
                onClick={() => {
                  if (canReportWin && method === "discard" && player.id !== winnerId) {
                    setPayerId(player.id);
                  } else {
                    onSelect(player.id);
                  }
                }}
                type="button"
              >
                <span>{player.seat}</span>
                <strong>{player.name}</strong>
                <em>{formatScore(score)}</em>
                {isDealer && <b>庄</b>}
              </button>
              {canReportWin && (
                <div className="seat-actions">
                  <button
                    className={`seat-mini-action ${isWinner ? "active" : ""}`}
                    onClick={() => {
                      setWinnerId(player.id);
                      if (payerId === player.id) {
                        setPayerId(
                          table.players.find((item) => item.id !== player.id)?.id ?? "",
                        );
                      }
                    }}
                    type="button"
                  >
                    胡牌
                  </button>
                  {method === "discard" && player.id !== winnerId && (
                    <button
                      className={`seat-mini-action danger ${isPayer ? "active" : ""}`}
                      onClick={() => setPayerId(player.id)}
                      type="button"
                    >
                      点炮
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {canReportWin && (
        <section className="table-win-panel">
          <div className="win-panel-top">
            <div>
              <span>本手预估</span>
              <strong>{formatScore(scorePreview.amount)}</strong>
            </div>
            <div className="segmented">
              <button
                className={method === "discard" ? "active" : ""}
                onClick={() => setMethod("discard")}
                type="button"
              >
                点炮
              </button>
              <button
                className={method === "self" ? "active" : ""}
                onClick={() => setMethod("self")}
                type="button"
              >
                自摸
              </button>
            </div>
          </div>

          <div className="win-options-grid">
            {getWinOptions(activeProfile.id).map((option) => (
              <button
                className={selectedOptionIds.includes(option.id) ? "selected" : ""}
                key={option.id}
                onClick={() => toggleOption(option.id)}
                type="button"
              >
                <strong>{option.label}</strong>
                <span>{option.detail}</span>
              </button>
            ))}
          </div>

          <div className="win-adjust-grid">
            <label className="field-stack">
              <span>底分</span>
              <input
                inputMode="decimal"
                value={base}
                onChange={(event) => setBase(event.target.value)}
              />
            </label>
            <label className="field-stack">
              <span>花/杠/补分</span>
              <input
                inputMode="decimal"
                value={manualBonus}
                onChange={(event) => setManualBonus(event.target.value)}
              />
            </label>
            {method === "discard" && (
              <label className="check-row compact">
                <input
                  checked={covered}
                  onChange={(event) => setCovered(event.target.checked)}
                  type="checkbox"
                />
                <span>包赔整桌</span>
              </label>
            )}
          </div>

          <label className="field-stack">
            <span>备注</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="买马、封顶、桌规补充"
            />
          </label>

          <button
            className="primary-action"
            disabled={!winnerId || scorePreview.amount <= 0}
            onClick={reportWin}
            type="button"
          >
            <Plus size={18} />
            确认胡牌入账
          </button>
        </section>
      )}
    </section>
  );
}

function DealerQuickPanel({
  table,
  onSetDealer,
}: {
  table: TableState;
  onSetDealer: (playerId: string) => void;
}) {
  const [dealerId, setDealerId] = useState(table.currentDealerId ?? table.players[0]?.id ?? "");

  useEffect(() => {
    setDealerId(table.currentDealerId ?? table.players[0]?.id ?? "");
  }, [table.currentDealerId, table.players]);

  return (
    <section className="tool-panel">
      <div className="section-heading">
        <Settings2 size={18} />
        <h2>指定庄家</h2>
      </div>
      <div className="dealer-setting">
        <label className="field-stack">
          <span>庄家</span>
          <select value={dealerId} onChange={(event) => setDealerId(event.target.value)}>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-action"
          onClick={() => onSetDealer(dealerId)}
          type="button"
        >
          保存
        </button>
      </div>
    </section>
  );
}

function TileAnimation() {
  return (
    <div className="tile-animation" aria-hidden="true">
      {["东", "南", "西", "北", "中", "發", "白", "九"].map((tile, index) => (
        <span style={{ animationDelay: `${index * 0.18}s` }} key={`${tile}-${index}`}>
          {tile}
        </span>
      ))}
    </div>
  );
}

function HostMahjongTable({
  latestEntryId,
  table,
}: {
  latestEntryId?: string;
  table: TableState;
}) {
  const rankedPlayers = table.players
    .slice()
    .sort((a, b) => (table.scores[b.id] ?? 0) - (table.scores[a.id] ?? 0));
  const rankMap = Object.fromEntries(
    rankedPlayers.map((player, index) => [player.id, index + 1]),
  ) as Record<string, number>;

  return (
    <section className="host-table-stage" key={latestEntryId ?? "host-table"}>
      <div className="host-table-felt">
        <strong>{profileMap[table.profileId].shortName}</strong>
        <span>第 {table.handNumber} 局</span>
      </div>
      {table.players.map((player, index) => {
        const score = table.scores[player.id] ?? 0;
        const delta = score - table.startingScore;
        const isDealer = table.currentDealerId === player.id;
        const lastDelta = table.ledger[0]?.deltas[player.id] ?? 0;

        return (
          <article
            className={`host-seat-card host-seat-${index} ${isDealer ? "dealer" : ""}`}
            key={player.id}
          >
            <div className="host-seat-top">
              <span className="rank-badge">{rankMap[player.id]}</span>
              <span className="tile-badge">{player.marker}</span>
              {isDealer && <span className="dealer-badge">庄</span>}
            </div>
            <div>
              <h2>{player.name}</h2>
              <p>{player.seat}位</p>
            </div>
            <strong>{formatScore(score)}</strong>
            <div className="host-seat-footer">
              <span className={delta >= 0 ? "positive-text" : "negative-text"}>
                {formatDelta(delta)}
              </span>
              {lastDelta !== 0 && (
                <em className={lastDelta > 0 ? "positive-text" : "negative-text"}>
                  本手 {formatDelta(lastDelta)}
                </em>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function HostScoreWall({
  latestEntryId,
  table,
}: {
  latestEntryId?: string;
  table: TableState;
}) {
  return <HostMahjongTable latestEntryId={latestEntryId} table={table} />;
}

function SetupScreen({
  connection,
  onStart,
  shareUrls,
}: {
  connection: ConnectionState;
  onStart: Dispatch<SetStateAction<TableState | null>>;
  shareUrls: string[];
}) {
  const [profileId, setProfileId] = useState<VariantId>("nanjing");
  const [startingScore, setStartingScore] = useState("0");
  const [playerNames, setPlayerNames] = useState(DEFAULT_NAMES);
  const [dealerIndex, setDealerIndex] = useState(0);

  const profile = profileMap[profileId];

  const namedPlayers = playerNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const canStart = namedPlayers.length >= 2;

  const selectProfile = (nextProfileId: VariantId) => {
    setProfileId(nextProfileId);
    setStartingScore(String(profileMap[nextProfileId].defaultStartingScore));
  };

  const updateName = (index: number, value: string) => {
    setPlayerNames((current) =>
      current.map((name, itemIndex) => (itemIndex === index ? value : name)),
    );
  };

  const startTable = () => {
    if (!canStart) return;
    const players = namedPlayers.map((name, index) => ({
      id: uid(),
      name,
      seat: SEATS[index] ?? `${index + 1}`,
      marker: MARKERS[index] ?? `${index + 1}`,
    }));
    const score = toNumber(startingScore, profile.defaultStartingScore);
    const now = new Date().toISOString();

    onStart({
      id: uid(),
      createdAt: now,
      updatedAt: now,
      profileId,
      startingScore: score,
      players,
      scores: Object.fromEntries(players.map((player) => [player.id, score])),
      ledger: [],
      currentDealerId: players[Math.min(dealerIndex, players.length - 1)]?.id,
      honba: 0,
      riichiPot: 0,
      handNumber: 1,
    });
  };

  return (
    <main className="setup-shell">
      <section className="setup-top">
        <div>
          <div className="brand-row">
            <span className="brand-mark">雀</span>
            <span>雀账台</span>
          </div>
          <h1>线下麻将记分台</h1>
        </div>
        <div className="tile-strip" aria-hidden="true">
          {["东", "南", "西", "北", "中", "發"].map((tile) => (
            <span key={tile}>{tile}</span>
          ))}
        </div>
      </section>

      <section className="setup-grid">
        <div className="setup-section profile-section">
          <div className="section-heading">
            <Settings2 size={18} />
            <h2>规则</h2>
          </div>
          <div className="profile-grid">
            {PROFILES.map((item) => (
              <button
                className={`profile-card ${item.tone} ${
                  profileId === item.id ? "selected" : ""
                }`}
                key={item.id}
                onClick={() => selectProfile(item.id)}
                type="button"
              >
                <span className="profile-tile">{item.tile}</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.chips.join(" / ")}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="setup-section">
          <div className="section-heading">
            <Users size={18} />
            <h2>玩家</h2>
          </div>
          <div className="player-fields">
            {playerNames.map((name, index) => (
              <label className="field-row" key={`${SEATS[index]}-${index}`}>
                <span>{SEATS[index] ?? index + 1}</span>
                <input
                  value={name}
                  onChange={(event) => updateName(index, event.target.value)}
                  placeholder={`玩家 ${index + 1}`}
                />
              </label>
            ))}
          </div>
          <label className="field-stack setup-dealer">
            <span>开局庄家</span>
            <select
              value={dealerIndex}
              onChange={(event) => setDealerIndex(Number(event.target.value))}
            >
              {playerNames.map((name, index) => (
                <option key={`${name}-${index}`} value={index}>
                  {name.trim() || `玩家 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="setup-section">
          <div className="section-heading">
            <Coins size={18} />
            <h2>初始分</h2>
          </div>
          <label className="field-stack">
            <span>{profile.shortName}</span>
            <input
              inputMode="numeric"
              value={startingScore}
              onChange={(event) => setStartingScore(event.target.value)}
            />
          </label>
          <button
            className="primary-action"
            disabled={!canStart}
            onClick={startTable}
            type="button"
          >
            <Calculator size={18} />
            开始记分
          </button>
        </div>

        <NetworkPanel connection={connection} shareUrls={shareUrls} compact />
      </section>
    </main>
  );
}

function AppHeader({
  connection,
  profile,
  shareUrls,
  table,
  onExport,
  onNewTable,
  onUndo,
}: {
  connection: ConnectionState;
  profile: ProfileDefinition;
  shareUrls: string[];
  table: TableState;
  onExport: () => void;
  onNewTable: () => void;
  onUndo: () => void;
}) {
  return (
    <header className="app-header">
      <div className="brand-block">
        <span className={`brand-mark tone-${profile.tone}`}>{profile.tile}</span>
        <div>
          <div className="brand-title">雀账台</div>
          <div className="brand-meta">
            {profile.name} · {formatDateTime(table.createdAt)}
          </div>
        </div>
      </div>
      <div className="header-actions">
        <ConnectionBadge connection={connection} />
        <ShareLinkButton shareUrls={shareUrls} />
        <button
          className="icon-action"
          onClick={onUndo}
          title="撤销上一笔"
          type="button"
        >
          <Undo2 size={18} />
        </button>
        <button
          className="icon-action"
          onClick={onExport}
          title="导出 CSV"
          type="button"
        >
          <Download size={18} />
        </button>
        <button className="secondary-action" onClick={onNewTable} type="button">
          <RotateCcw size={18} />
          新牌桌
        </button>
      </div>
    </header>
  );
}

function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  const connected = connection === "connected";
  const connecting = connection === "connecting";
  return (
    <span
      className={`connection-badge ${
        connected ? "connected" : connecting ? "connecting" : "offline"
      }`}
    >
      {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
      {connected ? "局域网同步" : connecting ? "连接中" : "本机模式"}
    </span>
  );
}

function ShareLinkButton({ shareUrls }: { shareUrls: string[] }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = withViewParam(shareUrls[0] ?? getBrowserOrigin(), "player");

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className="share-chip"
      onClick={copyLink}
      title="复制局域网地址"
      type="button"
    >
      <Copy size={16} />
      <span>{copied ? "已复制" : shareUrl.replace(/^https?:\/\//, "")}</span>
    </button>
  );
}

function NetworkPanel({
  compact = false,
  connection,
  shareUrls,
}: {
  compact?: boolean;
  connection: ConnectionState;
  shareUrls: string[];
}) {
  return (
    <section className={`side-panel network-panel ${compact ? "compact" : ""}`}>
      <div className="section-heading">
        <Link size={18} />
        <h2>局域网</h2>
        <ConnectionBadge connection={connection} />
      </div>
      <div className="network-list">
        {(shareUrls.length ? shareUrls : [getBrowserOrigin()]).map((url) => (
          <code key={url}>{url}</code>
        ))}
      </div>
    </section>
  );
}

function PersonalScoreBar({
  selectedPlayerId,
  table,
  onSelect,
}: {
  selectedPlayerId: string;
  table: TableState;
  onSelect: (playerId: string) => void;
}) {
  const selectedPlayer = table.players.find((player) => player.id === selectedPlayerId);
  const score = selectedPlayer ? table.scores[selectedPlayer.id] ?? 0 : 0;
  const delta = score - table.startingScore;
  const rank = selectedPlayer
    ? table.players
        .slice()
        .sort((a, b) => (table.scores[b.id] ?? 0) - (table.scores[a.id] ?? 0))
        .findIndex((player) => player.id === selectedPlayer.id) + 1
    : 0;

  return (
    <section className="personal-bar">
      <div className="personal-selector">
        <UserRound size={18} />
        <label className="field-stack">
          <span>这台设备</span>
          <select
            value={selectedPlayerId}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">选择玩家</option>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedPlayer ? (
        <div className="personal-score">
          <span>{selectedPlayer.name}</span>
          <strong>{formatScore(score)}</strong>
          <em className={delta >= 0 ? "positive-text" : "negative-text"}>
            第 {rank} · {formatDelta(delta)}
          </em>
        </div>
      ) : (
        <div className="personal-score muted">
          <span>未选择</span>
          <strong>--</strong>
          <em>选择后突出显示自己的点数</em>
        </div>
      )}
    </section>
  );
}

function Scoreboard({
  selectedPlayerId,
  table,
}: {
  selectedPlayerId: string;
  table: TableState;
}) {
  const rankedPlayers = useMemo(
    () =>
      table.players
        .slice()
        .sort((a, b) => (table.scores[b.id] ?? 0) - (table.scores[a.id] ?? 0)),
    [table],
  );
  const leaderId = rankedPlayers[0]?.id;

  return (
    <section className="scoreboard" aria-label="当前分数">
      {rankedPlayers.map((player, index) => {
        const score = table.scores[player.id] ?? 0;
        const delta = score - table.startingScore;
        const isDealer = table.currentDealerId === player.id;
        return (
          <article
            className={`score-card ${player.id === leaderId ? "leader" : ""} ${
              player.id === selectedPlayerId ? "own" : ""
            }`}
            key={player.id}
          >
            <div className="score-card-top">
              <span className="rank-badge">{index + 1}</span>
              <span className="tile-badge">{player.marker}</span>
              {isDealer && <span className="dealer-badge">庄</span>}
            </div>
            <div>
              <h2>{player.name}</h2>
              <p>{player.seat}位</p>
            </div>
            <div className="score-number">{formatScore(score)}</div>
            <div className={`delta-pill ${delta >= 0 ? "positive" : "negative"}`}>
              {formatDelta(delta)}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function CommonWinForm({
  preferredPlayerId,
  table,
  profile,
  onSubmit,
}: {
  preferredPlayerId?: string;
  table: TableState;
  profile: ProfileDefinition;
  onSubmit: (payload: CommonWinPayload) => void;
}) {
  const [winnerId, setWinnerId] = useState(
    preferredPlayerId || table.players[0]?.id || "",
  );
  const [method, setMethod] = useState<WinMethod>("discard");
  const [payerId, setPayerId] = useState(table.players[1]?.id ?? "");
  const [base, setBase] = useState(String(profile.defaultUnit));
  const [multiplier, setMultiplier] = useState("1");
  const [bonus, setBonus] = useState("0");
  const [covered, setCovered] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const preferredExists = table.players.some((player) => player.id === preferredPlayerId);
    const nextWinnerId = preferredExists
      ? preferredPlayerId
      : table.players[0]?.id ?? "";
    setWinnerId(nextWinnerId ?? "");
    setPayerId(
      table.players.find((player) => player.id !== nextWinnerId)?.id ??
        table.players[0]?.id ??
        "",
    );
    setBase(String(profile.defaultUnit));
    setMultiplier("1");
    setBonus("0");
    setCovered(false);
    setNote("");
  }, [preferredPlayerId, table.id, profile.defaultUnit, table.players]);

  const amount = Math.max(
    0,
    toNumber(base, profile.defaultUnit) * toNumber(multiplier, 1) +
      toNumber(bonus, 0),
  );

  const validPayers = table.players.filter((player) => player.id !== winnerId);
  const activePayerId =
    validPayers.some((player) => player.id === payerId) && payerId !== winnerId
      ? payerId
      : validPayers[0]?.id;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!winnerId || amount <= 0) return;
    onSubmit({
      winnerId,
      method,
      payerId: activePayerId ?? winnerId,
      amount,
      base: toNumber(base, profile.defaultUnit),
      multiplier: toNumber(multiplier, 1),
      bonus: toNumber(bonus, 0),
      covered,
      note,
    });
    setNote("");
  };

  return (
    <section className="tool-panel">
      <div className="section-heading">
        <Trophy size={18} />
        <h2>胡牌</h2>
        <span className="amount-preview">{formatScore(amount)}</span>
      </div>

      <form className="form-grid" onSubmit={submit}>
        <label className="field-stack">
          <span>赢家</span>
          <select value={winnerId} onChange={(event) => setWinnerId(event.target.value)}>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field-stack">
          <span>方式</span>
          <div className="segmented">
            <button
              className={method === "discard" ? "active" : ""}
              onClick={() => setMethod("discard")}
              type="button"
            >
              点炮
            </button>
            <button
              className={method === "self" ? "active" : ""}
              onClick={() => setMethod("self")}
              type="button"
            >
              自摸
            </button>
          </div>
        </div>

        {method === "discard" && (
          <label className="field-stack">
            <span>支付</span>
            <select
              value={activePayerId}
              onChange={(event) => setPayerId(event.target.value)}
            >
              {validPayers.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field-stack">
          <span>底分</span>
          <input
            inputMode="decimal"
            value={base}
            onChange={(event) => setBase(event.target.value)}
          />
        </label>

        <label className="field-stack">
          <span>倍数</span>
          <input
            inputMode="decimal"
            value={multiplier}
            onChange={(event) => setMultiplier(event.target.value)}
          />
        </label>

        <label className="field-stack">
          <span>补贴</span>
          <input
            inputMode="decimal"
            value={bonus}
            onChange={(event) => setBonus(event.target.value)}
          />
        </label>

        <div className="quick-row">
          {profile.quickAmounts.map((value) => (
            <button
              key={value}
              onClick={() => {
                setBase(String(value));
                setMultiplier("1");
                setBonus("0");
              }}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>

        {method === "discard" && (
          <label className="check-row">
            <input
              checked={covered}
              onChange={(event) => setCovered(event.target.checked)}
              type="checkbox"
            />
            <span>包赔整桌</span>
          </label>
        )}

        <label className="field-stack wide">
          <span>备注</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="杠、花、封顶、包牌"
          />
        </label>

        <button className="primary-action wide" disabled={amount <= 0} type="submit">
          <Plus size={18} />
          入账
        </button>
      </form>
    </section>
  );
}

function RiichiPanel({
  preferredPlayerId,
  table,
  onDeclare,
  onSettle,
  onRotateDealer,
  onSetDealer,
  onChangeHonba,
}: {
  preferredPlayerId?: string;
  table: TableState;
  onDeclare: (playerId: string) => void;
  onSettle: (payload: RiichiPayload) => void;
  onRotateDealer: () => void;
  onSetDealer: (playerId: string) => void;
  onChangeHonba: (step: number) => void;
}) {
  const dealer = getPlayer(table, table.currentDealerId ?? table.players[0].id);
  const [dealerId, setDealerId] = useState(dealer.id);
  const [riichiPlayerId, setRiichiPlayerId] = useState(
    preferredPlayerId || table.players[0]?.id || "",
  );
  const [winnerId, setWinnerId] = useState(
    preferredPlayerId || table.players[0]?.id || "",
  );
  const [winType, setWinType] = useState<"ron" | "tsumo">("ron");
  const [payerId, setPayerId] = useState(table.players[1]?.id ?? "");
  const [ronPoints, setRonPoints] = useState("8000");
  const [dealerPayment, setDealerPayment] = useState("2000");
  const [nonDealerPayment, setNonDealerPayment] = useState("1000");
  const [advance, setAdvance] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    const preferredExists = table.players.some((player) => player.id === preferredPlayerId);
    const nextPlayerId = preferredExists
      ? preferredPlayerId
      : table.players[0]?.id ?? "";
    setDealerId(table.currentDealerId ?? table.players[0]?.id ?? "");
    setRiichiPlayerId(nextPlayerId ?? "");
    setWinnerId(nextPlayerId ?? "");
    setPayerId(
      table.players.find((player) => player.id !== nextPlayerId)?.id ??
        table.players[1]?.id ??
        "",
    );
    setNote("");
  }, [preferredPlayerId, table.currentDealerId, table.id, table.players]);

  const validPayers = table.players.filter((player) => player.id !== winnerId);
  const activePayerId =
    validPayers.some((player) => player.id === payerId) && payerId !== winnerId
      ? payerId
      : validPayers[0]?.id;
  const winnerIsDealer = winnerId === table.currentDealerId;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!winnerId) return;
    onSettle({
      winnerId,
      winType,
      payerId: activePayerId ?? winnerId,
      ronPoints: Math.max(0, toNumber(ronPoints, 0)),
      dealerPayment: Math.max(0, toNumber(dealerPayment, 0)),
      nonDealerPayment: Math.max(0, toNumber(nonDealerPayment, 0)),
      advance,
      note,
    });
    setNote("");
  };

  return (
    <section className="tool-panel riichi-panel">
      <div className="section-heading">
        <Star size={18} />
        <h2>日麻</h2>
        <span className="amount-preview">{table.honba} 本场</span>
      </div>

      <div className="riichi-status">
        <div>
          <span>东家</span>
          <strong>{dealer.name}</strong>
        </div>
        <div>
          <span>立直棒</span>
          <strong>{formatScore(table.riichiPot)}</strong>
        </div>
        <button className="icon-action" onClick={onRotateDealer} title="换庄" type="button">
          <Shuffle size={18} />
        </button>
        <button
          className="icon-action"
          onClick={() => onChangeHonba(-1)}
          title="本场 -1"
          type="button"
        >
          <Minus size={18} />
        </button>
        <button
          className="icon-action"
          onClick={() => onChangeHonba(1)}
          title="本场 +1"
          type="button"
        >
          <Plus size={18} />
        </button>
      </div>

      <div className="inline-form">
        <select value={dealerId} onChange={(event) => setDealerId(event.target.value)}>
          {table.players.map((player) => (
            <option key={player.id} value={player.id}>
              {player.name}
            </option>
          ))}
        </select>
        <button
          className="secondary-action"
          onClick={() => onSetDealer(dealerId)}
          type="button"
        >
          <Settings2 size={18} />
          指定庄家
        </button>
      </div>

      <div className="inline-form">
        <select
          value={riichiPlayerId}
          onChange={(event) => setRiichiPlayerId(event.target.value)}
        >
          {table.players.map((player) => (
            <option key={player.id} value={player.id}>
              {player.name}
            </option>
          ))}
        </select>
        <button
          className="secondary-action"
          onClick={() => onDeclare(riichiPlayerId)}
          type="button"
        >
          <CircleDollarSign size={18} />
          立直
        </button>
      </div>

      <form className="form-grid" onSubmit={submit}>
        <label className="field-stack">
          <span>赢家</span>
          <select value={winnerId} onChange={(event) => setWinnerId(event.target.value)}>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field-stack">
          <span>方式</span>
          <div className="segmented">
            <button
              className={winType === "ron" ? "active" : ""}
              onClick={() => setWinType("ron")}
              type="button"
            >
              荣和
            </button>
            <button
              className={winType === "tsumo" ? "active" : ""}
              onClick={() => setWinType("tsumo")}
              type="button"
            >
              自摸
            </button>
          </div>
        </div>

        {winType === "ron" ? (
          <>
            <label className="field-stack">
              <span>放铳</span>
              <select
                value={activePayerId}
                onChange={(event) => setPayerId(event.target.value)}
              >
                {validPayers.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-stack">
              <span>点数</span>
              <input
                inputMode="numeric"
                value={ronPoints}
                onChange={(event) => setRonPoints(event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="field-stack">
              <span>{winnerIsDealer ? "每家" : "庄家付"}</span>
              <input
                inputMode="numeric"
                value={dealerPayment}
                onChange={(event) => setDealerPayment(event.target.value)}
              />
            </label>
            {!winnerIsDealer && (
              <label className="field-stack">
                <span>闲家付</span>
                <input
                  inputMode="numeric"
                  value={nonDealerPayment}
                  onChange={(event) => setNonDealerPayment(event.target.value)}
                />
              </label>
            )}
          </>
        )}

        <label className="check-row">
          <input
            checked={advance}
            onChange={(event) => setAdvance(event.target.checked)}
            type="checkbox"
          />
          <span>结算后推进</span>
        </label>

        <label className="field-stack wide">
          <span>备注</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="番符、役满、连庄"
          />
        </label>

        <button className="primary-action wide" type="submit">
          <ReceiptText size={18} />
          日麻入账
        </button>
      </form>
    </section>
  );
}

function GiveScoreForm({
  selectedPlayerId,
  table,
  onSubmit,
}: {
  selectedPlayerId: string;
  table: TableState;
  onSubmit: (
    label: string,
    description: string,
    deltas: Record<string, number>,
    note?: string,
  ) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [amount, setAmount] = useState("10");
  const [note, setNote] = useState("");
  const giver = table.players.find((player) => player.id === selectedPlayerId);
  const targets = table.players.filter((player) => player.id !== selectedPlayerId);
  const value = Math.max(0, toNumber(amount, 0));

  useEffect(() => {
    setTargetId(
      table.players.find((player) => player.id !== selectedPlayerId)?.id ??
        table.players[0]?.id ??
        "",
    );
  }, [selectedPlayerId, table.id, table.players]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = table.players.find((player) => player.id === targetId);
    if (!giver || !target || value <= 0) return;

    const deltas = makeDeltas(table.players);
    deltas[giver.id] -= value;
    deltas[target.id] += value;
    onSubmit(`${giver.name} 给 ${target.name}`, `给分 ${value}`, deltas, note);
    setNote("");
  };

  return (
    <section className="tool-panel give-panel">
      <div className="section-heading">
        <UserRound size={18} />
        <h2>给分</h2>
        <span className="amount-preview">{giver ? giver.name : "先选自己"}</span>
      </div>

      <form className="form-grid" onSubmit={submit}>
        <label className="field-stack">
          <span>给谁</span>
          <select
            disabled={!giver}
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {targets.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field-stack">
          <span>分数</span>
          <input
            disabled={!giver}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="field-stack">
          <span>备注</span>
          <input
            disabled={!giver}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="包牌、补分、买马"
          />
        </label>

        <button
          className="primary-action wide"
          disabled={!giver || value <= 0 || !targetId}
          type="submit"
        >
          <Plus size={18} />
          确认给分
        </button>
      </form>
    </section>
  );
}

function ManualEntryForm({
  table,
  onSubmit,
}: {
  table: TableState;
  onSubmit: (
    label: string,
    description: string,
    deltas: Record<string, number>,
    note?: string,
  ) => void;
}) {
  const [mode, setMode] = useState<"adjust" | "transfer">("transfer");
  const [targetId, setTargetId] = useState(table.players[0]?.id ?? "");
  const [fromId, setFromId] = useState(table.players[1]?.id ?? "");
  const [amount, setAmount] = useState("10");
  const [direction, setDirection] = useState<"add" | "subtract">("add");
  const [note, setNote] = useState("");

  useEffect(() => {
    setTargetId(table.players[0]?.id ?? "");
    setFromId(table.players[1]?.id ?? "");
    setNote("");
  }, [table.id, table.players]);

  const value = Math.max(0, toNumber(amount, 0));
  const canSubmit = value > 0 && (mode === "adjust" || targetId !== fromId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const deltas = makeDeltas(table.players);
    const target = getPlayer(table, targetId);

    if (mode === "transfer") {
      const from = getPlayer(table, fromId);
      deltas[from.id] -= value;
      deltas[target.id] += value;
      onSubmit(`${from.name} 转 ${target.name}`, `转账 ${value}`, deltas, note);
    } else {
      const signed = direction === "add" ? value : -value;
      deltas[target.id] += signed;
      onSubmit(`${target.name} 修正`, `手动 ${formatDelta(signed)}`, deltas, note);
    }

    setNote("");
  };

  return (
    <section className="tool-panel">
      <div className="section-heading">
        <Calculator size={18} />
        <h2>修正</h2>
      </div>

      <form className="form-grid" onSubmit={submit}>
        <div className="field-stack">
          <span>类型</span>
          <div className="segmented">
            <button
              className={mode === "transfer" ? "active" : ""}
              onClick={() => setMode("transfer")}
              type="button"
            >
              转账
            </button>
            <button
              className={mode === "adjust" ? "active" : ""}
              onClick={() => setMode("adjust")}
              type="button"
            >
              加减
            </button>
          </div>
        </div>

        {mode === "transfer" && (
          <label className="field-stack">
            <span>付款</span>
            <select value={fromId} onChange={(event) => setFromId(event.target.value)}>
              {table.players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field-stack">
          <span>{mode === "transfer" ? "收款" : "玩家"}</span>
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>

        {mode === "adjust" && (
          <div className="field-stack">
            <span>方向</span>
            <div className="segmented icon-segment">
              <button
                className={direction === "add" ? "active" : ""}
                onClick={() => setDirection("add")}
                title="加分"
                type="button"
              >
                <Plus size={16} />
              </button>
              <button
                className={direction === "subtract" ? "active" : ""}
                onClick={() => setDirection("subtract")}
                title="减分"
                type="button"
              >
                <Minus size={16} />
              </button>
            </div>
          </div>
        )}

        <label className="field-stack">
          <span>金额</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="field-stack wide">
          <span>备注</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="罚分、补录、结算修正"
          />
        </label>

        <button className="secondary-action wide" disabled={!canSubmit} type="submit">
          <Plus size={18} />
          添加流水
        </button>
      </form>
    </section>
  );
}

function TablePanel({
  table,
  profile,
  onReset,
  onRotateDealer,
  onRotateSeats,
  onSetDealer,
}: {
  table: TableState;
  profile: ProfileDefinition;
  onReset: () => void;
  onRotateDealer: () => void;
  onRotateSeats: () => void;
  onSetDealer: (playerId: string) => void;
}) {
  const [dealerId, setDealerId] = useState(table.currentDealerId ?? table.players[0]?.id ?? "");
  const totalScore = table.players.reduce(
    (sum, player) => sum + (table.scores[player.id] ?? 0),
    0,
  );
  const leader = table.players
    .slice()
    .sort((a, b) => (table.scores[b.id] ?? 0) - (table.scores[a.id] ?? 0))[0];

  useEffect(() => {
    setDealerId(table.currentDealerId ?? table.players[0]?.id ?? "");
  }, [table.currentDealerId, table.players]);

  return (
    <section className="side-panel">
      <div className="section-heading">
        <Settings2 size={18} />
        <h2>牌桌</h2>
      </div>

      <div className="metric-list">
        <div>
          <span>规则</span>
          <strong>{profile.name}</strong>
        </div>
        <div>
          <span>局数</span>
          <strong>{table.ledger.length}</strong>
        </div>
        <div>
          <span>总分</span>
          <strong>{formatScore(totalScore + table.riichiPot)}</strong>
        </div>
        <div>
          <span>领先</span>
          <strong>{leader?.name ?? "-"}</strong>
        </div>
      </div>

      <div className="dealer-setting">
        <label className="field-stack">
          <span>指定庄家</span>
          <select value={dealerId} onChange={(event) => setDealerId(event.target.value)}>
            {table.players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-action"
          onClick={() => onSetDealer(dealerId)}
          type="button"
        >
          <Settings2 size={18} />
          保存
        </button>
      </div>

      <div className="side-actions">
        <button className="secondary-action" onClick={onRotateSeats} type="button">
          <RotateCw size={18} />
          转座
        </button>
        <button className="secondary-action" onClick={onRotateDealer} type="button">
          <Shuffle size={18} />
          换庄
        </button>
        <button className="danger-action" onClick={onReset} type="button">
          <RotateCcw size={18} />
          重置
        </button>
      </div>
    </section>
  );
}

function HistoryPanel({
  table,
  onUndo,
}: {
  table: TableState;
  onUndo: () => void;
}) {
  const stats = useMemo(() => {
    const initial = Object.fromEntries(
      table.players.map((player) => [
        player.id,
        {
          wins: 0,
          self: 0,
          paid: 0,
          earned: 0,
        },
      ]),
    ) as Record<string, { wins: number; self: number; paid: number; earned: number }>;

    table.ledger.forEach((entry) => {
      if (entry.meta?.winnerId && initial[entry.meta.winnerId]) {
        initial[entry.meta.winnerId].wins += 1;
        if (entry.meta.method === "self" || entry.meta.method === "tsumo") {
          initial[entry.meta.winnerId].self += 1;
        }
      }
      Object.entries(entry.deltas).forEach(([playerId, delta]) => {
        if (!initial[playerId]) return;
        if (delta > 0) initial[playerId].earned += delta;
        if (delta < 0) initial[playerId].paid += Math.abs(delta);
      });
    });
    return initial;
  }, [table.ledger, table.players]);

  return (
    <section className="side-panel history-panel">
      <div className="section-heading">
        <History size={18} />
        <h2>流水</h2>
        <button className="icon-action small" onClick={onUndo} title="撤销上一笔" type="button">
          <Undo2 size={16} />
        </button>
      </div>

      <div className="stats-grid">
        {table.players.map((player) => (
          <div className="stat-tile" key={player.id}>
            <span>{player.name}</span>
            <strong>{stats[player.id]?.wins ?? 0} 胡</strong>
            <small>{formatScore(stats[player.id]?.earned ?? 0)} 入</small>
          </div>
        ))}
      </div>

      <div className="entry-list">
        {table.ledger.length === 0 ? (
          <div className="empty-state">
            <ReceiptText size={24} />
            <span>暂无流水</span>
          </div>
        ) : (
          table.ledger.map((entry) => (
            <article className="entry-card" key={entry.id}>
              <div className="entry-main">
                <span>{formatDateTime(entry.createdAt)}</span>
                <strong>{entry.label}</strong>
                <p>{entry.description}</p>
                {entry.note && <p className="entry-note">{entry.note}</p>}
              </div>
              <div className="delta-list">
                {table.players.map((player) => {
                  const delta = entry.deltas[player.id] ?? 0;
                  if (delta === 0) return null;
                  return (
                    <span
                      className={`delta-chip ${delta > 0 ? "positive" : "negative"}`}
                      key={player.id}
                    >
                      {player.name} {formatDelta(delta)}
                    </span>
                  );
                })}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
