/**
 * Hand-written minimal ABIs. Only what the keeper calls — keeping this narrow means a
 * contract change that matters shows up as a type error rather than a runtime revert.
 */

export const registryAbi = [
  {
    type: "function",
    name: "activeMandates",
    inputs: [],
    outputs: [{type: "uint256[]"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "markAndEnforce",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [{type: "bool"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "markAndEnforceBatch",
    inputs: [{name: "mandateIds", type: "uint256[]"}],
    outputs: [{name: "breachedCount", type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "liveEquity",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "headroom",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [
      {name: "absolute", type: "uint256"},
      {name: "bps", type: "uint256"},
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "floorOf",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [
      {name: "effectiveFloor", type: "uint256"},
      {name: "lastEquity", type: "uint256"},
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "stateOf",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "trader", type: "address"},
          {name: "account", type: "address"},
          {name: "highWaterMark", type: "uint256"},
          {name: "dayStartEquity", type: "uint256"},
          {name: "dayStartTime", type: "uint64"},
          {name: "lastMarkedEquity", type: "uint256"},
          {name: "lastMarkedAt", type: "uint64"},
          {name: "issuedAt", type: "uint64"},
          {name: "status", type: "uint8"},
          {name: "breachKind", type: "uint8"},
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "termsOf",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "allocation", type: "uint256"},
          {name: "maxDrawdownBps", type: "uint16"},
          {name: "dailyLossBps", type: "uint16"},
          {name: "profitSplitBps", type: "uint16"},
          {name: "maxPositionBps", type: "uint16"},
          {name: "expiry", type: "uint64"},
          {name: "resetHourUtc", type: "uint8"},
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "issue",
    inputs: [
      {name: "trader", type: "address"},
      {
        name: "terms",
        type: "tuple",
        components: [
          {name: "allocation", type: "uint256"},
          {name: "maxDrawdownBps", type: "uint16"},
          {name: "dailyLossBps", type: "uint16"},
          {name: "profitSplitBps", type: "uint16"},
          {name: "maxPositionBps", type: "uint16"},
          {name: "expiry", type: "uint64"},
          {name: "resetHourUtc", type: "uint8"},
        ],
      },
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "EquityMarked",
    inputs: [
      {name: "mandateId", type: "uint256", indexed: true},
      {name: "equity", type: "uint256"},
      {name: "highWaterMark", type: "uint256"},
      {name: "trailingFloor", type: "uint256"},
      {name: "dailyFloor", type: "uint256"},
      {name: "netPnl", type: "int256"},
      {name: "markedAt", type: "uint64"},
      {name: "by", type: "address", indexed: true},
    ],
  },
  {
    type: "event",
    name: "Breached",
    inputs: [
      {name: "mandateId", type: "uint256", indexed: true},
      {name: "kind", type: "uint8"},
      {name: "equityAtBreach", type: "uint256"},
      {name: "floor", type: "uint256"},
      {name: "enforcedBy", type: "address", indexed: true},
    ],
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      {name: "mandateId", type: "uint256", indexed: true},
      {name: "finalStatus", type: "uint8"},
      {name: "finalEquity", type: "uint256"},
      {name: "traderPayout", type: "uint256"},
      {name: "poolReturn", type: "uint256"},
    ],
  },
] as const;

export const oracleAbi = [
  {
    type: "function",
    name: "pushPrices",
    inputs: [
      {name: "marketIds", type: "uint16[]"},
      {name: "prices", type: "uint256[]"},
      {name: "publishedAt", type: "uint64"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "pushPrice",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "newPrice", type: "uint256"},
      {name: "publishedAt", type: "uint64"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "price",
    inputs: [{name: "marketId", type: "uint16"}],
    outputs: [
      {name: "price", type: "uint256"},
      {name: "publishedAt", type: "uint64"},
    ],
    stateMutability: "view",
  },
] as const;

export const venueAbi = [
  {
    type: "function",
    name: "totalNotional",
    inputs: [{name: "account", type: "address"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "unrealisedPnl",
    inputs: [{name: "account", type: "address"}],
    outputs: [{type: "int256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "openMarkets",
    inputs: [{name: "account", type: "address"}],
    outputs: [{type: "uint16[]"}],
    stateMutability: "view",
  },
] as const;

export const poolAbi = [
  {type: "function", name: "totalAssets", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {type: "function", name: "idleAssets", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {
    type: "function",
    name: "totalAllocated",
    inputs: [],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pricePerShare",
    inputs: [],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
] as const;
