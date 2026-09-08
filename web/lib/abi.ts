/**
 * Hand-written minimal ABIs. Only what the app reads and writes — keeping this narrow means a
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
          {name: "dayStartBalance", type: "uint256"},
          {name: "dayStartTime", type: "uint64"},
          {name: "lastMarkedEquity", type: "uint256"},
          {name: "lastMarkedAt", type: "uint64"},
          {name: "issuedAt", type: "uint64"},
          {name: "largestDailyGain", type: "uint256"},
          {name: "profitableDays", type: "uint32"},
          {name: "tradingDays", type: "uint32"},
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
          {name: "drawdownMode", type: "uint8"},
          {name: "maxConsistencyBps", type: "uint16"},
          {name: "minProfitableDays", type: "uint16"},
          {name: "payoutCushionBps", type: "uint16"},
          {name: "touchIsBreach", type: "bool"},
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
          {name: "drawdownMode", type: "uint8"},
          {name: "maxConsistencyBps", type: "uint16"},
          {name: "minProfitableDays", type: "uint16"},
          {name: "payoutCushionBps", type: "uint16"},
          {name: "touchIsBreach", type: "bool"},
        ],
      },
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "payoutEligibility",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [
      {name: "ok", type: "bool"},
      {name: "reason", type: "uint8"},
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "consistencyScore",
    inputs: [{name: "mandateId", type: "uint256"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
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

export const accountAbi = [
  {
    type: "function",
    name: "openPosition",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "isLong", type: "bool"},
      {name: "size", type: "uint256"},
      {name: "limitPrice", type: "uint256"},
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "closePosition",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "limitPrice", type: "uint256"},
    ],
    outputs: [{type: "int256"}],
    stateMutability: "nonpayable",
  },
  {type: "function", name: "equity", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {type: "function", name: "notional", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {type: "function", name: "trader", inputs: [], outputs: [{type: "address"}], stateMutability: "view"},
] as const;

export const venueExtraAbi = [
  {
    type: "function",
    name: "getPosition",
    inputs: [
      {name: "account", type: "address"},
      {name: "marketId", type: "uint16"},
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "marketId", type: "uint16"},
          {name: "isLong", type: "bool"},
          {name: "size", type: "uint256"},
          {name: "entryPrice", type: "uint256"},
          {name: "margin", type: "uint256"},
          {name: "fundingIndexAtEntry", type: "int256"},
          {name: "openedAt", type: "uint64"},
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewFill",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "size", type: "uint256"},
      {name: "isBuy", type: "bool"},
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "freeCollateral",
    inputs: [{name: "account", type: "address"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
] as const;

export const poolExtraAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      {name: "assets", type: "uint256"},
      {name: "receiver", type: "address"},
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requestWithdrawal",
    inputs: [{name: "shares", type: "uint256"}],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimWithdrawal",
    inputs: [],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelWithdrawal",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "previewClaim",
    inputs: [{name: "lp", type: "address"}],
    outputs: [
      {name: "assets", type: "uint256"},
      {name: "ready", type: "bool"},
      {name: "funded", type: "bool"},
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{name: "", type: "address"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "convertToAssets",
    inputs: [{name: "shares", type: "uint256"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "utilisationBps",
    inputs: [],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "withdrawalDelay",
    inputs: [],
    outputs: [{type: "uint64"}],
    stateMutability: "view",
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      {name: "spender", type: "address"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [{type: "bool"}],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{name: "", type: "address"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      {name: "", type: "address"},
      {name: "", type: "address"},
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {name: "to", type: "address"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const demoIssuerAbi = [
  {type: "function", name: "claim", inputs: [], outputs: [{type: "uint256"}], stateMutability: "nonpayable"},
  {
    type: "function",
    name: "claimStatus",
    inputs: [{name: "who", type: "address"}],
    outputs: [
      {name: "claimable", type: "bool"},
      {name: "reason", type: "string"},
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mandateOf",
    inputs: [{name: "", type: "address"}],
    outputs: [{type: "uint256"}],
    stateMutability: "view",
  },
  {type: "function", name: "allocation", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {type: "function", name: "maxDrawdownBps", inputs: [], outputs: [{type: "uint16"}], stateMutability: "view"},
  {type: "function", name: "dailyLossBps", inputs: [], outputs: [{type: "uint16"}], stateMutability: "view"},
  {type: "function", name: "profitSplitBps", inputs: [], outputs: [{type: "uint16"}], stateMutability: "view"},
  {type: "function", name: "maxPositionBps", inputs: [], outputs: [{type: "uint16"}], stateMutability: "view"},
  {type: "function", name: "claimsMade", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
  {type: "function", name: "maxClaims", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
] as const;
