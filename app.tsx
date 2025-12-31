import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { GameState, GamePhase, Player, Suit, Rank, Card } from "./types";
import {
  createDeck,
  determineTrickWinner,
  calculateRoundPoints,
} from "./utils";
import PlayingTable from "./components/PlayingTable";
import {
  Play,
  AlertCircle,
  Loader2,
  Share2,
  Copy,
  Send,
  Zap,
  RotateCcw,
  Users,
  User,
  ArrowRightLeft,
  Edit3,
  PlusCircle,
  LogIn,
} from "lucide-react";
import { supabase } from "./supabase";

const App: React.FC = () => {
  // --- State ---
  const [userId] = useState(() => {
    try {
      const saved = localStorage.getItem("hokm_user_id");
      if (saved) return saved;
      const newId = "user_" + Math.floor(Math.random() * 1000000);
      localStorage.setItem("hokm_user_id", newId);
      return newId;
    } catch (e) {
      return "user_" + Math.floor(Math.random() * 1000000);
    }
  });

  const [lastRoomId, setLastRoomId] = useState(
    () => localStorage.getItem("last_room_id") || ""
  );
  const [selectedMode, setSelectedMode] = useState<"2p" | "4p">("2p");
  const [inputName, setInputName] = useState(
    () => localStorage.getItem("hokm_player_name") || ""
  );

  const [roomId, setRoomId] = useState("");
  const [showJoinInput, setShowJoinInput] = useState(false);
  const [inGame, setInGame] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [gameState, setGameState] = useState<GameState>({
    roomId: "",
    mode: "2p",
    phase: GamePhase.LOBBY,
    players: [],
    deck: [],
    hakimId: null,
    hokm: null,
    currentTurnPlayerId: null,
    tableCards: [],
    scores: { 1: 0, 2: 0 },
    currentRoundTricks: { 1: 0, 2: 0 },
    hakimDeterminationCards: [],
    lastWinnerId: null,
    logs: [],
    lastActionTimestamp: 0,
  });

  const stateRef = useRef(gameState);
  useEffect(() => {
    stateRef.current = gameState;
  }, [gameState]);

  // Save name to local storage
  useEffect(() => {
    if (inputName) localStorage.setItem("hokm_player_name", inputName);
  }, [inputName]);

  const getDisplayName = () => inputName.trim() || `بازیکن ${userId.slice(-4)}`;

  // --- Helper: Update Whole Game State to Supabase ---
  const updateRemoteState = async (newState: Partial<GameState>) => {
    if (!roomId) return;

    const fullState = { ...stateRef.current, ...newState };

    const { error } = await supabase
      .from("rooms")
      .update({ data: fullState })
      .eq("room_id", roomId);

    if (error) console.error("Error updating state:", error);
  };

  // --- Helper: Transaction-like Update (Fetch -> Apply -> Save) ---
  const performTransaction = async (
    modifier: (currentState: GameState) => GameState | null,
    overrideRoomId?: string
  ) => {
    const targetId = overrideRoomId || roomId;
    if (!targetId) return;

    // 1. Fetch latest
    const { data, error } = await supabase
      .from("rooms")
      .select("data")
      .eq("room_id", targetId)
      .single();

    if (error || !data) {
      console.error("Transaction failed: could not fetch", error);
      throw new Error("ROOM_NOT_FOUND");
    }

    const currentRemoteState = data.data as GameState;

    // 2. Apply modifier
    const newState = modifier(currentRemoteState);

    if (newState) {
      // 3. Update
      const { error: updateError } = await supabase
        .from("rooms")
        .update({ data: newState })
        .eq("room_id", targetId);

      if (updateError) throw updateError;
    }
  };

  // --- CLEANUP LOGIC ---
  const cleanupAndLeave = async () => {
    const currentRoomId = stateRef.current.roomId || roomId;
    if (!currentRoomId) return;

    // Use local state clone
    const currentState = JSON.parse(
      JSON.stringify(stateRef.current)
    ) as GameState;
    const myIdx = currentState.players.findIndex((p) => p && p.id === userId);

    if (myIdx !== -1) {
      // Rule: If Lobby, remove player completely (null). If Game, just mark disconnected.
      if (currentState.phase === GamePhase.LOBBY) {
        currentState.players[myIdx] = null;
      } else {
        if (currentState.players[myIdx]) {
          currentState.players[myIdx]!.isConnected = false;
        }
      }

      // Check active players (connected)
      const activePlayersCount = currentState.players.filter(
        (p) => p !== null && p.isConnected
      ).length;

      // Extract Supabase Config for Raw Fetch
      const sbUrl = (supabase as any).supabaseUrl;
      const sbKey = (supabase as any).supabaseKey;

      const headers = {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      };
      const restUrl = `${sbUrl}/rest/v1/rooms?room_id=eq.${currentRoomId}`;

      if (activePlayersCount === 0) {
        // DELETE using fetch with keepalive: true
        // This ensures the request survives the page unload/close
        fetch(restUrl, {
          method: "DELETE",
          headers: headers,
          keepalive: true,
        }).catch((e) => console.error("Cleanup Delete Error", e));
      } else {
        // UPDATE using fetch with keepalive: true
        fetch(restUrl, {
          method: "PATCH",
          headers: headers,
          body: JSON.stringify({ data: currentState }),
          keepalive: true,
        }).catch((e) => console.error("Cleanup Update Error", e));
      }
    }
  };

  // Hook for window close / refresh / mobile background
  useEffect(() => {
    const handleUnload = () => {
      cleanupAndLeave();
    };

    // 'pagehide' is more reliable on mobile (iOS/Android) than 'beforeunload'
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      // Don't auto cleanup on component unmount to prevent ghosting on mobile refresh
      // if (roomId) cleanupAndLeave();
    };
  }, [roomId, userId]);

  // --- Validate Last Room (SAFE MODE: Do not delete ID automatically) ---
  useEffect(() => {
    if (!lastRoomId || inGame) return;

    // We only check to update internal state, but we NEVER remove the localStorage key automatically.
    // This prevents losing the room ID on mobile network glitches.
    const validateRoom = async () => {
      try {
        const { data, error } = await supabase
          .from("rooms")
          .select("data")
          .eq("room_id", lastRoomId)
          .single();
        // Just logging for debug
        if (error)
          console.log("Validation check failed, but keeping ID just in case.");
      } catch (e) {
        console.error("Error validating room:", e);
      }
    };

    validateRoom();
  }, [lastRoomId, inGame]);

  // --- Supabase Sync & Presence ---
  useEffect(() => {
    if (!inGame || !roomId) return;

    // 1. Fetch Function (Used for Initial & Polling)
    const fetchLatestState = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("data")
        .eq("room_id", roomId)
        .single();

      if (data && data.data) {
        setGameState(data.data as GameState);
        setLoading(false);
      } else if (error) {
        console.error("Fetch error:", error);
        if (!data) {
          // Only disconnect if we receive a definitive null data response (room deleted)
          // Do not disconnect on network error
          if (error.code === "PGRST116") {
            setInGame(false);
            setError("اتاق بسته شد.");
            setRoomId("");
          }
        }
      }
    };

    fetchLatestState(); // Initial Load

    // 2. Subscribe to DB Changes (Realtime)
    const channel = supabase
      .channel(`room_game_${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "rooms",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          if (payload.new && (payload.new as any).data) {
            setGameState((payload.new as any).data as GameState);
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "rooms",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          setInGame(false);
          setError("اتاق بسته شد.");
          setRoomId("");
        }
      )
      .subscribe();

    // 3. Polling Fallback
    const pollInterval = setInterval(fetchLatestState, 3000);

    // 4. Presence (Disconnect Detection)
    const presenceChannel = supabase.channel(`room_presence_${roomId}`, {
      config: { presence: { key: userId } },
    });

    presenceChannel
      .on("presence", { event: "sync" }, () => {
        // Presence Sync Logic: Detect ungraceful disconnects
        const state = presenceChannel.presenceState();
        const onlineIds = Object.keys(state);

        // If in game, check for players in DB who are NOT in presence
        if (stateRef.current && stateRef.current.phase !== GamePhase.LOBBY) {
          const currentPlayers = stateRef.current.players;
          let updateNeeded = false;

          const updatedPlayers = currentPlayers.map((p) => {
            if (!p) return null;

            // CRITICAL FIX FOR MOBILE:
            // I (the current user) am running this code, so I am definitely online.
            // Do NOT mark myself as offline based on presence sync lag.
            if (p.id === userId) {
              if (!p.isConnected) return { ...p, isConnected: true };
              return p;
            }

            const isOnline = onlineIds.includes(p.id);

            // If DB says online but Presence says offline -> Mark Disconnected
            // If DB says offline but Presence says online -> Mark Connected
            if (p.isConnected !== isOnline) {
              updateNeeded = true;
              return { ...p, isConnected: isOnline };
            }
            return p;
          });

          if (updateNeeded) {
            // Only active clients should perform the update.
            // To avoid spam, check if *I* am online and connected.
            // Also ensure we don't accidentally kick others if our own connection is flaky
            if (onlineIds.includes(userId)) {
              updateRemoteState({ players: updatedPlayers });
            }
          }
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await presenceChannel.track({
            online_at: new Date().toISOString(),
            userId,
          });
          if (roomId) {
            performTransaction((s) => {
              const myIdx = s.players.findIndex((p) => p && p.id === userId);
              if (myIdx !== -1 && s.players[myIdx]) {
                s.players[myIdx]!.isConnected = true;
                return s;
              }
              return null;
            }, roomId).catch(() => {});
          }
        }
      });

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(channel);
      supabase.removeChannel(presenceChannel);
    };
  }, [inGame, roomId, userId]);

  // --- Game Logic Controllers (Host Only) ---
  const hostId = gameState.players.find((p) => p !== null && p.isConnected)?.id;
  const isHost = hostId === userId;
  const filledPlayersCount = gameState.players.filter((p) => p !== null).length;
  const maxPlayers = gameState.mode === "4p" ? 4 : 2;

  // Start Game Trigger
  useEffect(() => {
    if (!isHost) return;
    if (
      gameState.phase === GamePhase.LOBBY &&
      filledPlayersCount === maxPlayers
    ) {
      const timer = setTimeout(() => {
        if (stateRef.current.phase === GamePhase.LOBBY) {
          updateRemoteState({
            phase: GamePhase.HAKIM_DETERMINATION,
            logs: [...(stateRef.current.logs || []), "بازی شروع شد"],
          });
        }
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [gameState.phase, filledPlayersCount, maxPlayers, isHost, roomId]);

  // Hakim Determination Logic
  useEffect(() => {
    if (!isHost) return;

    if (
      gameState.phase === GamePhase.HAKIM_DETERMINATION &&
      gameState.hakimDeterminationCards.length === 0
    ) {
      const deck = createDeck();
      let index = 0;
      let tempCards: Card[] = [];

      const interval = setInterval(() => {
        if (stateRef.current.phase !== GamePhase.HAKIM_DETERMINATION) {
          clearInterval(interval);
          return;
        }

        const card = deck[index];
        index++;
        tempCards.push(card);

        updateRemoteState({
          hakimDeterminationCards: [...tempCards],
        });

        if (card.rank === Rank.Ace) {
          clearInterval(interval);
          const winningPlayerIndex = (index - 1) % maxPlayers;
          const winner = stateRef.current.players[winningPlayerIndex];

          if (winner) {
            setTimeout(() => {
              const logs = stateRef.current.logs || [];
              updateRemoteState({
                hakimId: winner.id,
                currentTurnPlayerId: winner.id,
                phase: GamePhase.DEALING_INITIAL,
                logs: [...logs, `${winner.name} حاکم شد`],
              });
            }, 3000);
          }
        }
      }, 1500);

      return () => clearInterval(interval);
    }
  }, [gameState.phase, isHost, roomId, maxPlayers]);

  // Dealing Logic
  useEffect(() => {
    if (!isHost) return;

    if (gameState.phase === GamePhase.DEALING_INITIAL) {
      if (gameState.deck.length > 0) return;

      const fullDeck = createDeck();
      const hakimIndex = gameState.players.findIndex(
        (p) => p && p.id === gameState.hakimId
      );

      if (hakimIndex === -1) return;

      const p1Hand = fullDeck.slice(0, 5);
      const remainingDeck = fullDeck.slice(5);

      setTimeout(() => {
        const newPlayers = [...gameState.players];
        if (newPlayers[hakimIndex]) {
          newPlayers[hakimIndex] = { ...newPlayers[hakimIndex]!, hand: p1Hand };
        }

        updateRemoteState({
          deck: remainingDeck,
          players: newPlayers,
          phase: GamePhase.HAKIM_CHOOSING_SUIT,
        });
      }, 1000);
    }

    if (gameState.phase === GamePhase.DEALING_REMAINDER) {
      if (gameState.players.every((p) => p && p.hand.length > 5)) return;

      const deck = [...gameState.deck];
      const hakimIndex = gameState.players.findIndex(
        (p) => p && p.id === gameState.hakimId
      );

      if (gameState.mode === "2p") {
        const otherIndex = hakimIndex === 0 ? 1 : 0;
        const hakimExtra = deck.slice(0, 8);
        const opponentHand = deck.slice(8, 21);

        setTimeout(() => {
          const newPlayers = [...gameState.players];
          if (newPlayers[hakimIndex]) {
            const currentHakimHand = newPlayers[hakimIndex]!.hand || [];
            if (currentHakimHand.length === 5) {
              newPlayers[hakimIndex]!.hand = [
                ...currentHakimHand,
                ...hakimExtra,
              ];
            }
          }
          if (newPlayers[otherIndex]) {
            newPlayers[otherIndex]!.hand = opponentHand;
          }

          updateRemoteState({
            players: newPlayers,
            phase: GamePhase.PLAYING,
            currentTurnPlayerId: gameState.hakimId,
          });
        }, 800);
      } else {
        setTimeout(() => {
          const newPlayers = [...gameState.players];
          let currentDeckIdx = 0;
          for (let i = 1; i <= 3; i++) {
            const targetIdx = (hakimIndex + i) % 4;
            const hand = deck.slice(currentDeckIdx, currentDeckIdx + 13);
            currentDeckIdx += 13;
            if (newPlayers[targetIdx]) {
              newPlayers[targetIdx]!.hand = hand;
            }
          }
          const hakimExtra = deck.slice(currentDeckIdx, currentDeckIdx + 8);
          if (newPlayers[hakimIndex]) {
            const currentHand = newPlayers[hakimIndex]!.hand || [];
            if (currentHand.length === 5) {
              newPlayers[hakimIndex]!.hand = [...currentHand, ...hakimExtra];
            }
          }

          updateRemoteState({
            players: newPlayers,
            phase: GamePhase.PLAYING,
            currentTurnPlayerId: gameState.hakimId,
          });
        }, 800);
      }
    }
  }, [gameState.phase, isHost, roomId, gameState.mode]);

  // Trick Resolution
  useEffect(() => {
    const maxP = gameState.mode === "4p" ? 4 : 2;
    if (
      gameState.tableCards?.length === maxP &&
      gameState.phase === GamePhase.PLAYING
    ) {
      if (isHost) {
        const timer = setTimeout(() => {
          finishTrickRemote();
        }, 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [gameState.tableCards, gameState.mode, isHost]);

  // --- Actions ---

  const handleSetHokm = (suit: Suit) => {
    if (gameState.hakimId !== userId) return;
    updateRemoteState({
      hokm: suit,
      phase: GamePhase.DEALING_REMAINDER,
    });
  };

  const handlePlayCard = async (card: Card) => {
    if (gameState.currentTurnPlayerId !== userId) return;

    const maxP = gameState.mode === "4p" ? 4 : 2;
    if (gameState.tableCards && gameState.tableCards.length >= maxP) return;

    const player = gameState.players.find((p) => p && p.id === userId);
    if (!player) return;

    if (gameState.tableCards && gameState.tableCards.length > 0) {
      const leadSuit = gameState.tableCards[0].card.suit;
      const hasSuit = player.hand.some((c) => c.suit === leadSuit);
      if (hasSuit && card.suit !== leadSuit) {
        alert(
          "باید " +
            (leadSuit === Suit.Hearts
              ? "دل"
              : leadSuit === Suit.Spades
              ? "پیک"
              : leadSuit === Suit.Clubs
              ? "گشنیز"
              : "خشت") +
            " بازی کنید!"
        );
        return;
      }
    }

    await performTransaction((roomData) => {
      if (roomData.currentTurnPlayerId !== userId) return null;
      if (roomData.tableCards && roomData.tableCards.length >= maxP)
        return null;

      const currentPlayerIndex = roomData.players.findIndex(
        (p) => p && p.id === userId
      );
      if (currentPlayerIndex === -1) return null;

      const currentPlayer = roomData.players[currentPlayerIndex];
      if (!currentPlayer) return null;

      const newHand = currentPlayer.hand.filter((c) => c.id !== card.id);
      roomData.players[currentPlayerIndex]!.hand = newHand;

      if (!roomData.tableCards) roomData.tableCards = [];
      roomData.tableCards.push({ playerId: userId, card });

      roomData.lastActionTimestamp = Date.now();

      const nextPlayerIndex = (currentPlayerIndex + 1) % maxP;
      const nextPlayer = roomData.players[nextPlayerIndex];
      roomData.currentTurnPlayerId = nextPlayer ? nextPlayer.id : null;

      return roomData;
    });
  };

  const finishTrickRemote = async () => {
    await performTransaction((roomData) => {
      if (!roomData || !roomData.tableCards) return null;

      const maxP = roomData.mode === "4p" ? 4 : 2;
      if (roomData.tableCards.length < maxP) return null;

      const cards = roomData.tableCards;
      const winnerId = determineTrickWinner(
        cards,
        roomData.hokm!,
        cards[0].card.suit
      );
      const winnerPlayer = roomData.players.find((p) => p && p.id === winnerId);
      if (!winnerPlayer) return null;

      const winnerTeamId = winnerPlayer.teamId;

      if (!roomData.currentRoundTricks)
        roomData.currentRoundTricks = { 1: 0, 2: 0 };
      roomData.currentRoundTricks[winnerTeamId] =
        (roomData.currentRoundTricks[winnerTeamId] || 0) + 1;

      roomData.lastWinnerId = winnerId;
      roomData.currentTurnPlayerId = winnerId;

      let handOver = false;
      let handWinnerTeamId = 0;
      if (roomData.currentRoundTricks[1] >= 7) {
        handWinnerTeamId = 1;
        handOver = true;
      }
      if (roomData.currentRoundTricks[2] >= 7) {
        handWinnerTeamId = 2;
        handOver = true;
      }

      if (!handOver) {
        roomData.tableCards = [];
      } else {
        const hakimPlayer = roomData.players.find(
          (p) => p && p.id === roomData.hakimId
        );
        const isHakimTeam = hakimPlayer?.teamId === handWinnerTeamId;
        const losingTeamId = handWinnerTeamId === 1 ? 2 : 1;
        const losingTricks = roomData.currentRoundTricks[losingTeamId] || 0;

        const points = calculateRoundPoints(7, losingTricks, isHakimTeam);

        if (!roomData.scores) roomData.scores = { 1: 0, 2: 0 };
        roomData.scores[handWinnerTeamId] =
          (roomData.scores[handWinnerTeamId] || 0) + points;

        if (roomData.scores[handWinnerTeamId] >= 7) {
          roomData.phase = GamePhase.MATCH_END;
          roomData.logs = [
            ...(roomData.logs || []),
            `بازی تمام شد. تیم ${handWinnerTeamId} برنده شد.`,
          ];
          return roomData;
        }

        let newHakimId = roomData.hakimId;
        if (!isHakimTeam) {
          const currentHakimIdx = roomData.players.findIndex(
            (p) => p && p.id === roomData.hakimId
          );
          const nextIdx = (currentHakimIdx + 1) % maxP;
          const nextPlayer = roomData.players[nextIdx];
          newHakimId = nextPlayer ? nextPlayer.id : null;
        }

        roomData.phase = GamePhase.DEALING_INITIAL;
        roomData.deck = [];
        roomData.tableCards = [];
        roomData.currentRoundTricks = { 1: 0, 2: 0 };
        roomData.hakimId = newHakimId;
        roomData.hokm = null;
        roomData.hakimDeterminationCards = [];

        if (!roomData.logs) roomData.logs = [];
        roomData.logs.push(
          `دست تمام شد. امتیاز جدید: ${roomData.scores[1]} - ${roomData.scores[2]}`
        );
      }

      return roomData;
    });
  };

  const createRoom = async (specificId?: string) => {
    setLoading(true);
    const rid =
      specificId || Math.floor(100000 + Math.random() * 900000).toString();

    const players: (Player | null)[] =
      selectedMode === "2p" ? [null, null] : [null, null, null, null];

    const myName = getDisplayName();
    players[0] = {
      id: userId,
      name: myName,
      hand: [],
      teamId: 1,
      isConnected: true,
    };

    const initialState: GameState = {
      roomId: rid,
      mode: selectedMode,
      phase: GamePhase.LOBBY,
      players: players,
      deck: [],
      hakimId: null,
      hokm: null,
      currentTurnPlayerId: null,
      tableCards: [],
      scores: { 1: 0, 2: 0 },
      currentRoundTricks: { 1: 0, 2: 0 },
      hakimDeterminationCards: [],
      lastWinnerId: null,
      logs: ["اتاق ساخته شد"],
      lastActionTimestamp: 0,
    };

    try {
      const { error } = await supabase
        .from("rooms")
        .insert({ room_id: rid, data: initialState });

      if (error) throw error;

      setRoomId(rid);
      localStorage.setItem("last_room_id", rid);
      setLastRoomId(rid);
      const newUrl =
        window.location.protocol +
        "//" +
        window.location.host +
        window.location.pathname +
        "?room=" +
        rid;
      window.history.pushState({ path: newUrl }, "", newUrl);
      setInGame(true);
    } catch (e) {
      console.error(e);
      setError("خطا در ساخت اتاق");
      setInGame(false);
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = async (specificRoomId?: string) => {
    const targetRoomId = specificRoomId || roomId;
    if (!targetRoomId) return setError("لطفا کد اتاق را وارد کنید");

    setLoading(true);
    if (specificRoomId) setRoomId(specificRoomId);

    try {
      await performTransaction((roomData) => {
        const existingIdx = roomData.players.findIndex(
          (p) => p && p.id === userId
        );
        if (existingIdx !== -1) {
          // REJOIN LOGIC: Update connection status to true
          if (roomData.players[existingIdx]) {
            roomData.players[existingIdx]!.isConnected = true;

            // Fix stuck hakim determination on rejoin
            if (
              roomData.phase === GamePhase.HAKIM_DETERMINATION &&
              !roomData.hakimId
            ) {
              roomData.hakimDeterminationCards = [];
            }
          }
          return roomData;
        }

        let emptySlotIdx = -1;
        const max = roomData.mode === "2p" ? 2 : 4;
        for (let i = 0; i < max; i++) {
          if (!roomData.players[i]) {
            emptySlotIdx = i;
            break;
          }
        }

        if (emptySlotIdx === -1) {
          throw new Error("FULL");
        }

        const teamId = emptySlotIdx % 2 === 0 ? 1 : 2;
        const myName = getDisplayName();

        const pNew: Player = {
          id: userId,
          name: myName,
          hand: [],
          teamId: teamId,
          isConnected: true,
        };

        roomData.players[emptySlotIdx] = pNew;
        return roomData;
      }, targetRoomId);

      localStorage.setItem("last_room_id", targetRoomId);
      setLastRoomId(targetRoomId);
      setInGame(true);
    } catch (e: any) {
      console.error(e);
      if (e.message === "FULL") setError("اتاق پر است");
      else if (e.message === "ROOM_NOT_FOUND") setError("اتاق پیدا نشد");
      else setError("خطا در اتصال");
      setLoading(false);
    }
  };

  const handleSwitchSeat = async (targetIndex: number) => {
    if (gameState.phase !== GamePhase.LOBBY) return;

    await performTransaction((roomData) => {
      const myCurrentIndex = roomData.players.findIndex(
        (p) => p && p.id === userId
      );
      if (myCurrentIndex === -1) return null;

      const targetSlot = roomData.players[targetIndex];
      if (targetSlot) return null;

      const me = roomData.players[myCurrentIndex];
      if (!me) return null;

      me.teamId = targetIndex % 2 === 0 ? 1 : 2;
      roomData.players[targetIndex] = me;
      roomData.players[myCurrentIndex] = null;

      return roomData;
    });
  };

  const handleCreatePublicRoom = async () => {
    setLoading(true);
    const targetRoomId = "public_room";

    try {
      const { data } = await supabase
        .from("rooms")
        .select("room_id")
        .eq("room_id", targetRoomId)
        .single();
      if (data) {
        setLoading(false);
        alert("اتاق قبلا ساخته شده و با ورود خودکار به اتاق وصل شوید");
        return;
      }
      await createRoom(targetRoomId);
    } catch (e) {
      console.error(e);
      setError("خطا در بررسی وضعیت اتاق");
      setLoading(false);
    }
  };

  const handleJoinPublicRoom = async () => {
    setLoading(true);
    setError("");

    // Strategy:
    // 1. Check Saved Room ID (Priority 1)
    // 2. Scan Supabase for ANY active room (Priority 2: My Room > Any Open Room)

    try {
      // 1. Saved Room
      const savedId = localStorage.getItem("last_room_id");
      if (savedId) {
        // Check if it really exists/is valid
        const { data } = await supabase
          .from("rooms")
          .select("room_id")
          .eq("room_id", savedId)
          .single();
        if (data) {
          await joinRoom(savedId);
          return;
        }
      }

      // 2. Search for ANY room
      // Fetch latest 50 rooms to find a candidate (increased from 20)
      const { data: allRooms } = await supabase
        .from("rooms")
        .select("room_id, data")
        .limit(50);

      if (allRooms && allRooms.length > 0) {
        const parsedRooms = allRooms.map((r) => ({
          id: r.room_id,
          state: r.data as GameState,
        }));

        // Filter active rooms (NOT finished)
        const activeRooms = parsedRooms.filter(
          (r) => r.state && r.state.phase !== GamePhase.MATCH_END
        );

        if (activeRooms.length > 0) {
          // Priority A: Room where I am already listed as a player (RECONNECT)
          // This is critical for mobile users returning to their game
          const existingGame = activeRooms.find((r) =>
            r.state.players.some((p) => p && p.id === userId)
          );

          if (existingGame) {
            console.log("Found existing game (Reconnect):", existingGame.id);
            await joinRoom(existingGame.id);
            return;
          }

          // Priority B: Any active room.
          // We simply try the first active one found.
          console.log(
            "Joining first available active room:",
            activeRooms[0].id
          );
          await joinRoom(activeRooms[0].id);
          return;
        }
      }

      // 3. Fallback to public_room if nothing found in query
      const { data: publicData } = await supabase
        .from("rooms")
        .select("room_id")
        .eq("room_id", "public_room")
        .single();
      if (publicData) {
        await joinRoom("public_room");
        return;
      }

      setLoading(false);
      alert("هیچ اتاق فعالی پیدا نشد. لطفا یک اتاق جدید بسازید.");
    } catch (e) {
      console.error("Auto join error:", e);
      setLoading(false);
      setError("خطا در جستجوی اتاق");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRoomId = params.get("room");
    if (urlRoomId && !inGame) {
      setRoomId(urlRoomId);
      setTimeout(() => {
        joinRoom(urlRoomId);
      }, 500);
    }
  }, []);

  if (!inGame) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-900 to-slate-800 flex flex-col items-center p-4 text-white font-sans overflow-y-auto">
        <div className="w-full max-w-sm flex flex-col items-center justify-center min-h-full py-8">
          <div className="mb-6 flex flex-col items-center">
            <span className="text-6xl mb-2">♠️</span>
            <h1 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-yellow-600">
              حکم حقیقت
            </h1>

            <p className="mt-4 text-cyan-300 text-sm text-center max-w-xs leading-6 bg-black/20 p-3 rounded-xl border border-white/5 backdrop-blur-sm">
              برای شروع، ابتدا نام خود را وارد کنید، حالت بازی را انتخاب کرده و
              دکمه
              <span className="text-yellow-400 font-bold mx-1">
                ساخت اتاق جدید
              </span>
              یا
              <span className="text-green-400 font-bold mx-1">ورود خودکار</span>
              را بزنید.
            </p>
          </div>

          <div className="w-full space-y-4">
            {/* Name Input */}
            <div className="relative mb-2">
              <User
                className="absolute right-3 top-3 text-gray-400"
                size={20}
              />
              <input
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                placeholder="نام خود را وارد کنید"
                className="w-full bg-black/30 border border-white/20 rounded-xl px-10 py-3 text-right focus:border-yellow-500 outline-none transition-colors"
              />
            </div>

            {/* Mode Selection */}
            <div className="flex bg-black/40 p-1 rounded-xl mb-6">
              <button
                onClick={() => setSelectedMode("2p")}
                className={`flex-1 py-2 rounded-lg font-bold flex items-center justify-center gap-2 transition-all ${
                  selectedMode === "2p"
                    ? "bg-white/10 text-white shadow"
                    : "text-gray-500"
                }`}
              >
                <User size={18} />2 نفره
              </button>
              <button
                onClick={() => setSelectedMode("4p")}
                className={`flex-1 py-2 rounded-lg font-bold flex items-center justify-center gap-2 transition-all ${
                  selectedMode === "4p"
                    ? "bg-white/10 text-white shadow"
                    : "text-gray-500"
                }`}
              >
                <Users size={18} />4 نفره
              </button>
            </div>

            {/* Create Public Room */}
            <button
              onClick={handleCreatePublicRoom}
              disabled={loading}
              className="w-full py-4 bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 rounded-2xl font-black text-xl shadow-xl shadow-orange-900/20 flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 ring-4 ring-orange-500/20"
            >
              {loading ? (
                <Loader2 className="animate-spin w-8 h-8" />
              ) : (
                <PlusCircle className="text-white w-8 h-8" />
              )}
              ساخت اتاق جدید (میزبان)
            </button>

            {/* Join Public Room (Auto Entry) */}
            <button
              onClick={handleJoinPublicRoom}
              disabled={loading}
              className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 hover:from-green-500 hover:to-green-400 rounded-2xl font-black text-xl shadow-xl shadow-green-900/20 flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 ring-4 ring-green-500/20"
            >
              {loading ? (
                <Loader2 className="animate-spin w-8 h-8" />
              ) : (
                <LogIn className="text-white w-8 h-8" />
              )}
              ورود خودکار مهمان (ادامه بازی قبل)
            </button>

            {/* Join via Code */}
            {!showJoinInput ? (
              <button
                onClick={() => setShowJoinInput(true)}
                className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold text-gray-300 transition-all flex justify-center items-center gap-2 mt-4"
              >
                ورود با کد اتاق
              </button>
            ) : (
              <div className="bg-white/5 p-4 rounded-xl border border-white/10 animate-in fade-in slide-in-from-top-2 duration-200 mt-4">
                <div className="flex gap-2">
                  <input
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="کد اتاق"
                    type="number"
                    className="flex-1 bg-black/30 border border-white/20 rounded px-3 py-2 font-mono text-center tracking-widest outline-none focus:border-yellow-500"
                  />
                  <button
                    onClick={() => joinRoom()}
                    disabled={loading}
                    className="bg-blue-600/80 px-4 rounded font-bold hover:bg-blue-500 transition-colors disabled:opacity-50 text-sm whitespace-nowrap"
                  >
                    {loading ? <Loader2 className="animate-spin" /> : "ورود"}
                  </button>
                </div>
                {error && (
                  <p className="text-red-400 text-xs mt-2 flex items-center gap-1">
                    <AlertCircle size={12} /> {error}
                  </p>
                )}
                <button
                  onClick={() => setShowJoinInput(false)}
                  className="w-full text-center text-xs text-gray-500 mt-3 hover:text-white transition-colors"
                >
                  بازگشت
                </button>
              </div>
            )}
          </div>

          <div className="mt-12 text-center">
            <p className="text-yellow-500 text-sm font-bold tracking-widest drop-shadow-md opacity-90">
              ساخته شده توسط مرصاد پسر حقیقت
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --- LOBBY (Waiting Screen) ---
  if (gameState.phase === GamePhase.LOBBY && filledPlayersCount < maxPlayers) {
    const inviteLink = window.location.href.split("?")[0] + "?room=" + roomId;

    const copyLink = () => {
      navigator.clipboard.writeText(inviteLink);
      alert("لینک دعوت کپی شد!");
    };

    const shareToTelegram = () => {
      const text = "بیا حکم بزنیم! روی لینک زیر کلیک کن:";
      const url = `https://telegram.me/share/url?url=${encodeURIComponent(
        inviteLink
      )}&text=${encodeURIComponent(text)}`;
      window.open(url, "_blank");
    };

    return (
      <div className="min-h-screen bg-feltDark flex flex-col items-center justify-center text-white px-4">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <Loader2 className="w-6 h-6 animate-spin text-yellow-500" />
          <span>
            در انتظار بازیکنان ({filledPlayersCount}/{maxPlayers})...
          </span>
        </h2>

        {/* 4 Player Lobby Visualizer */}
        {gameState.mode === "4p" && (
          <div className="w-full max-w-md grid grid-cols-2 gap-4 mb-8">
            {gameState.players.map((p, idx) => {
              const isMe = p?.id === userId;
              const teamName = idx % 2 === 0 ? "تیم ۱" : "تیم ۲";
              const teamColor =
                idx % 2 === 0
                  ? "bg-green-600/20 border-green-500/30"
                  : "bg-red-600/20 border-red-500/30";

              return (
                <div
                  key={idx}
                  className={`relative p-4 rounded-xl border ${
                    p ? teamColor : "bg-white/5 border-dashed border-white/10"
                  } flex flex-col items-center justify-center h-24 transition-all`}
                >
                  <div className="text-xs text-gray-400 absolute top-2 right-2">
                    {teamName}
                  </div>
                  {p ? (
                    <>
                      <div className="font-bold">{p.name}</div>
                      {isMe && (
                        <div className="text-xs text-yellow-500">(شما)</div>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => handleSwitchSeat(idx)}
                      className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors animate-pulse text-yellow-400 font-bold"
                    >
                      <ArrowRightLeft size={12} />
                      یار شدن / انتخاب صندلی
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="w-full max-w-md bg-white/10 p-6 rounded-2xl border border-white/10 flex flex-col items-center gap-4">
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-2">کد اتاق:</p>
            <div className="text-4xl font-mono font-black tracking-widest text-white">
              {roomId}
            </div>
          </div>

          <div className="w-full h-[1px] bg-white/10 my-2"></div>

          <div className="flex w-full gap-2">
            <button
              onClick={shareToTelegram}
              className="flex-1 bg-blue-500 hover:bg-blue-400 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-transform active:scale-95"
            >
              <Send size={18} />
              تلگرام
            </button>
            <button
              onClick={copyLink}
              className="flex-1 bg-white/5 hover:bg-white/10 text-gray-300 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors border border-white/5"
            >
              <Copy size={18} />
              کپی
            </button>
          </div>

          <button
            onClick={() => {
              cleanupAndLeave();
              setInGame(false);
            }}
            className="text-xs text-red-400 mt-4 hover:text-red-300"
          >
            خروج از اتاق
          </button>
        </div>
      </div>
    );
  }

  if (gameState.phase === GamePhase.MATCH_END) {
    const myPlayer = gameState.players.find((p) => p && p.id === userId);
    const winnerTeam = gameState.scores[1] >= 7 ? 1 : 2;
    const isWinner = myPlayer?.teamId === winnerTeam;

    return (
      <div className="fixed inset-0 z-[100] bg-gradient-to-b from-gray-900 to-black flex flex-col items-center justify-center p-4 text-white text-center overflow-y-auto">
        <div className="text-9xl mb-4 animate-bounce">
          {isWinner ? "🏆" : "☠️"}
        </div>
        <h1 className="text-5xl font-black mb-4 text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-600">
          {isWinner ? "شما برنده شدید!" : "شما باختید!"}
        </h1>
        <div className="text-2xl mb-8 opacity-80">
          نتیجه نهایی:{" "}
          <span className="font-mono font-bold text-yellow-400 mx-2">
            {gameState.scores[1]} - {gameState.scores[2]}
          </span>
        </div>
        <button
          onClick={async () => {
            setLoading(true); // Visual feedback
            await cleanupAndLeave(); // Update DB status (disconnect/delete)

            localStorage.removeItem("last_room_id");
            setLastRoomId("");

            window.history.replaceState({}, "", window.location.pathname);
            window.location.reload();
          }}
          className="bg-white text-black px-8 py-3 rounded-full font-bold text-lg hover:scale-105 transition-transform"
        >
          بازگشت به منو
        </button>
      </div>
    );
  }

  return (
    <PlayingTable
      gameState={gameState}
      myPlayerId={userId}
      onCardPlay={handlePlayCard}
      onSetHokm={handleSetHokm}
    />
  );
};

export default App;
