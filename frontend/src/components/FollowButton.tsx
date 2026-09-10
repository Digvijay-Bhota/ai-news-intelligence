'use client';

import React, { useState } from 'react';
import { useFollows } from '../lib/followsContext';
import type { FollowTargetType } from '../types';

interface FollowButtonProps {
  targetType: FollowTargetType;
  targetId: string;
  label?: string;
  compact?: boolean;
  className?: string;
}

export function FollowButton({
  targetType,
  targetId,
  label,
  compact = false,
  className = '',
}: FollowButtonProps) {
  const { isFollowing, toggleFollow, isReady } = useFollows();
  const [isPending, setIsPending] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  if (!targetId) return null;

  const following = isFollowing(targetType, targetId);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPending) return;

    setIsPending(true);
    try {
      await toggleFollow(targetType, targetId);
    } finally {
      setIsPending(false);
    }
  };

  const defaultText = label ? label : `Follow ${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`;

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disabled={!isReady || isPending}
        aria-pressed={following}
        aria-label={following ? `Unfollow ${targetId}` : `Follow ${targetId}`}
        className={`inline-flex items-center justify-center font-medium rounded transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 text-xs px-2 py-0.5 ${
          following
            ? isHovered
              ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40'
              : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/40'
            : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400'
        } ${className}`}
      >
        {isPending ? (
          <span className="animate-spin inline-block mr-1">◌</span>
        ) : following ? (
          isHovered ? (
            <span className="mr-1">✕</span>
          ) : (
            <span className="mr-1">✓</span>
          )
        ) : (
          <span className="mr-1">+</span>
        )}
        <span>
          {following ? (isHovered ? 'Unfollow' : 'Following') : 'Follow'}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      disabled={!isReady || isPending}
      aria-pressed={following}
      aria-label={following ? `Unfollow ${targetId}` : `Follow ${targetId}`}
      className={`inline-flex items-center justify-center font-medium rounded-lg text-sm px-3.5 py-1.5 transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 ${
        following
          ? isHovered
            ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40'
            : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/50'
          : 'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 border border-transparent hover:shadow'
      } ${className}`}
    >
      {isPending ? (
        <span className="animate-spin inline-block mr-1.5">◌</span>
      ) : following ? (
        isHovered ? (
          <span className="mr-1.5 text-xs">✕</span>
        ) : (
          <span className="mr-1.5 text-xs">✓</span>
        )
      ) : (
        <span className="mr-1.5 text-sm">+</span>
      )}
      <span>
        {following ? (isHovered ? 'Unfollow' : 'Following') : defaultText}
      </span>
    </button>
  );
}
