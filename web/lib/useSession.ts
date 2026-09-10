"use client";

import {useCallback, useEffect, useState} from "react";
import type {Address} from "viem";
import {buildSiweMessage, SIWE_STATEMENT} from "./siwe";
import {CHAIN_ID} from "./chain";
import {useWallet} from "./useWallet";

export type Session = {
  address: Address;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Sign-in state for the app.
 *
 * Two distinct things live here and the difference matters to the UI:
 *
 *   - `wallet.address`  — a wallet is connected. Enough to send a transaction.
 *   - `session`         — that address *proved* it controls the key, and the server agrees.
 *
 * The chain is the source of truth for everything this app reads, so the session gates no
 * data. What it buys is identity that survives a reload: the app can open on *your* mandates
 * and *your* record instead of asking who you are on every page.
 */
export function useSession() {
  const wallet = useWallet();
  const [session, setSession] = useState<Session | null>();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", {cache: "no-store"});
      const json = (await res.json()) as {session: Session | null};
      setSession(json.session);
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A session belongs to one address. If the wallet switches accounts, the old session is
  // no longer about the person now using the browser — drop it rather than show their name
  // against someone else's wallet.
  useEffect(() => {
    if (!session || !wallet.address) return;
    if (session.address.toLowerCase() !== wallet.address.toLowerCase()) {
      void fetch("/api/auth/logout", {method: "POST"}).then(() => setSession(null));
    }
  }, [session, wallet.address]);

  const signIn = useCallback(async () => {
    setError(undefined);
    if (!wallet.address) {
      await wallet.connect();
      return; // the user still has to press sign in; connecting is a separate consent
    }
    if (!wallet.client) return;

    setSigningIn(true);
    try {
      const nonceRes = await fetch("/api/auth/nonce", {cache: "no-store"});
      const {nonce} = (await nonceRes.json()) as {nonce: string};

      const message = buildSiweMessage({
        domain: window.location.host,
        address: wallet.address,
        statement: SIWE_STATEMENT,
        uri: window.location.origin,
        version: "1",
        chainId: CHAIN_ID,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      const signature = await wallet.client.signMessage({
        account: wallet.address,
        message,
      });

      const verify = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message, signature}),
      });

      if (!verify.ok) {
        const {error: reason} = (await verify.json()) as {error?: string};
        setError(reason ?? "Sign-in failed");
        return;
      }
      await refresh();
    } catch (e) {
      setError(String(e).includes("denied") ? "Rejected in wallet." : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }, [wallet, refresh]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", {method: "POST"});
    setSession(null);
  }, []);

  return {
    ...wallet,
    session: session ?? null,
    /** Undefined until the first /me call resolves — lets the UI avoid a sign-in flash. */
    loading: session === undefined,
    signedIn: Boolean(session),
    signingIn,
    error,
    signIn,
    signOut,
  };
}
