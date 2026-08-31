'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { Article } from '../types';

export interface SavedArticleLocal {
  saved_id?: number;
  article: Article;
}

interface UserArticlesContextType {
  savedArticles: SavedArticleLocal[];
  hiddenArticleIds: Set<number>;
  saveArticle: (article: Article) => Promise<void>;
  unsaveArticle: (articleId: number) => Promise<void>;
  hideArticle: (articleId: number) => Promise<void>;
  unhideArticle: (articleId: number) => void;
  isReady: boolean;
}

const UserArticlesContext = createContext<UserArticlesContextType | undefined>(undefined);

export function UserArticlesProvider({ children }: { children: ReactNode }) {
  const [savedArticles, setSavedArticles] = useState<SavedArticleLocal[]>([]);
  const [hiddenArticleIds, setHiddenArticleIds] = useState<Set<number>>(new Set());
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    try {
      const storedSaved = localStorage.getItem('ai_news_saved');
      if (storedSaved) {
        setSavedArticles(JSON.parse(storedSaved));
      }
    } catch (e) {
      console.warn('Failed to parse saved articles from local storage', e);
    }

    try {
      const storedHidden = localStorage.getItem('ai_news_hidden');
      if (storedHidden) {
        setHiddenArticleIds(new Set(JSON.parse(storedHidden)));
      }
    } catch (e) {
      console.warn('Failed to parse hidden articles from local storage', e);
    }

    setIsReady(true);
  }, []);

  useEffect(() => {
    if (isReady) {
      localStorage.setItem('ai_news_saved', JSON.stringify(savedArticles));
    }
  }, [savedArticles, isReady]);

  useEffect(() => {
    if (isReady) {
      localStorage.setItem('ai_news_hidden', JSON.stringify(Array.from(hiddenArticleIds)));
    }
  }, [hiddenArticleIds, isReady]);

  const saveArticle = async (article: Article) => {
    if (savedArticles.some(s => s.article.id === article.id)) return;

    // Optimistic
    const newSaved = { article };
    setSavedArticles(prev => [newSaved, ...prev]);

    try {
      const res = await fetch('/api/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_raw_id: article.id })
      });
      if (!res.ok) throw new Error('Failed to save on backend');
      const data = await res.json();

      setSavedArticles(prev => prev.map(s =>
        s.article.id === article.id ? { ...s, saved_id: data.id } : s
      ));
    } catch (err) {
      console.error(err);
      // Rollback
      setSavedArticles(prev => prev.filter(s => s.article.id !== article.id));
    }
  };

  const unsaveArticle = async (articleId: number) => {
    const target = savedArticles.find(s => s.article.id === articleId);
    if (!target) return;

    // Optimistic
    setSavedArticles(prev => prev.filter(s => s.article.id !== articleId));

    try {
      if (target.saved_id) {
        const res = await fetch(`/api/saved/${target.saved_id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to unsave on backend');
      }
    } catch (err) {
      console.error(err);
      // Rollback
      setSavedArticles(prev => [target, ...prev]);
    }
  };

  const hideArticle = async (articleId: number) => {
    // Optimistic
    setHiddenArticleIds(prev => {
      const next = new Set(prev);
      next.add(articleId);
      return next;
    });

    try {
      const res = await fetch('/api/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_raw_id: articleId })
      });
      if (!res.ok) throw new Error('Failed to hide on backend');
    } catch (err) {
      console.error(err);
      // Rollback
      setHiddenArticleIds(prev => {
        const next = new Set(prev);
        next.delete(articleId);
        return next;
      });
    }
  };

  const unhideArticle = (articleId: number) => {
    setHiddenArticleIds(prev => {
      const next = new Set(prev);
      next.delete(articleId);
      return next;
    });
  };

  return (
    <UserArticlesContext.Provider value={{
      savedArticles,
      hiddenArticleIds,
      saveArticle,
      unsaveArticle,
      hideArticle,
      unhideArticle,
      isReady
    }}>
      {children}
    </UserArticlesContext.Provider>
  );
}

export function useUserArticles() {
  const context = useContext(UserArticlesContext);
  if (context === undefined) {
    throw new Error('useUserArticles must be used within a UserArticlesProvider');
  }
  return context;
}
