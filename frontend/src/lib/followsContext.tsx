'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import type { FollowTargetType, UserFollow } from '../types';

export interface FollowItem {
  id?: string;
  target_type: FollowTargetType;
  target_id: string;
  created_at?: number;
}

interface FollowsContextType {
  follows: FollowItem[];
  isFollowing: (targetType: FollowTargetType, targetId: string) => boolean;
  follow: (targetType: FollowTargetType, targetId: string) => Promise<void>;
  unfollow: (targetType: FollowTargetType, targetId: string) => Promise<void>;
  toggleFollow: (targetType: FollowTargetType, targetId: string) => Promise<void>;
  isReady: boolean;
  refreshFollows: () => Promise<void>;
}

const FollowsContext = createContext<FollowsContextType | undefined>(undefined);

const STORAGE_KEY = 'ai_news_follows';

export function FollowsProvider({ children }: { children: ReactNode }) {
  const [follows, setFollows] = useState<FollowItem[]>([]);
  const [isReady, setIsReady] = useState(false);

  // Load cached follows from localStorage initially, then fetch from BFF
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setFollows(JSON.parse(stored));
      }
    } catch (e) {
      console.warn('Failed to load cached follows from local storage', e);
    }
    setIsReady(true);
  }, []);

  const refreshFollows = useCallback(async () => {
    try {
      const res = await fetch('/api/follows');
      if (res.ok) {
        const json = await res.json();
        const items = json.data || json;
        if (Array.isArray(items)) {
          setFollows(items);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
          } catch {}
        }
      }
    } catch (err) {
      console.error('Failed to sync follows from backend', err);
    }
  }, []);

  useEffect(() => {
    if (isReady) {
      refreshFollows();
    }
  }, [isReady, refreshFollows]);

  // Persist follows to localStorage on change
  useEffect(() => {
    if (isReady) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(follows));
      } catch {}
    }
  }, [follows, isReady]);

  const isFollowing = useCallback(
    (targetType: FollowTargetType, targetId: string): boolean => {
      const normalizedTargetId = targetId.trim().toLowerCase();
      return follows.some(
        f => f.target_type === targetType && f.target_id.trim().toLowerCase() === normalizedTargetId
      );
    },
    [follows]
  );

  const follow = useCallback(
    async (targetType: FollowTargetType, targetId: string) => {
      const trimmedTargetId = targetId.trim();
      if (!trimmedTargetId || isFollowing(targetType, trimmedTargetId)) return;

      const optimisticItem: FollowItem = {
        target_type: targetType,
        target_id: trimmedTargetId,
        created_at: Math.floor(Date.now() / 1000),
      };

      setFollows(prev => [optimisticItem, ...prev]);

      try {
        const res = await fetch('/api/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_type: targetType, target_id: trimmedTargetId }),
        });

        if (!res.ok) {
          throw new Error(`Failed to follow: ${res.status}`);
        }

        const json = await res.json();
        const saved: UserFollow = json.data || json;
        if (saved && saved.id) {
          setFollows(prev =>
            prev.map(f =>
              f.target_type === targetType && f.target_id === trimmedTargetId ? { ...f, id: saved.id } : f
            )
          );
        }
      } catch (err) {
        console.error('Follow failed, rolling back', err);
        setFollows(prev =>
          prev.filter(f => !(f.target_type === targetType && f.target_id === trimmedTargetId))
        );
      }
    },
    [isFollowing]
  );

  const unfollow = useCallback(
    async (targetType: FollowTargetType, targetId: string) => {
      const trimmedTargetId = targetId.trim();
      const existing = follows.find(
        f => f.target_type === targetType && f.target_id.trim().toLowerCase() === trimmedTargetId.toLowerCase()
      );
      if (!existing) return;

      // Optimistic remove
      setFollows(prev =>
        prev.filter(
          f => !(f.target_type === targetType && f.target_id.trim().toLowerCase() === trimmedTargetId.toLowerCase())
        )
      );

      try {
        const res = await fetch(
          `/api/follows?target_type=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(
            trimmedTargetId
          )}`,
          { method: 'DELETE' }
        );

        if (!res.ok) {
          throw new Error(`Failed to unfollow: ${res.status}`);
        }
      } catch (err) {
        console.error('Unfollow failed, rolling back', err);
        setFollows(prev => [existing, ...prev]);
      }
    },
    [follows]
  );

  const toggleFollow = useCallback(
    async (targetType: FollowTargetType, targetId: string) => {
      if (isFollowing(targetType, targetId)) {
        await unfollow(targetType, targetId);
      } else {
        await follow(targetType, targetId);
      }
    },
    [isFollowing, follow, unfollow]
  );

  return (
    <FollowsContext.Provider
      value={{
        follows,
        isFollowing,
        follow,
        unfollow,
        toggleFollow,
        isReady,
        refreshFollows,
      }}
    >
      {children}
    </FollowsContext.Provider>
  );
}

export function useFollows() {
  const context = useContext(FollowsContext);
  if (context === undefined) {
    throw new Error('useFollows must be used within a FollowsProvider');
  }
  return context;
}
