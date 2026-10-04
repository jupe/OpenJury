"use client";

import { useEffect, useRef } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export function useRealtimeUpdates(
  client: SupabaseClient,
  userId: string,
  groupId: string | null,
  onUpdate: () => void,
) {
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    let active = true;
    const subscribe = (topic: string, event: string) => {
      let subscribed = false;
      let disconnected = false;
      const channel = client.channel(topic, { config: { private: true } })
        .on("broadcast", { event }, () => {
          if (active) onUpdateRef.current();
        })
        .subscribe((status) => {
          if (!active) return;
          if (status === "SUBSCRIBED") {
            if (subscribed || disconnected) onUpdateRef.current();
            subscribed = true;
            disconnected = false;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            disconnected = true;
          }
        });
      return channel;
    };

    const channels = [
      subscribe(`user:${userId}`, "membership_changed"),
      ...(groupId ? [subscribe(`group:${groupId}`, "data_changed")] : []),
    ];
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") onUpdateRef.current();
    };
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      active = false;
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      for (const channel of channels) void client.removeChannel(channel);
    };
  }, [client, userId, groupId]);
}
