import React from 'react';
import { AlertCircleIcon } from './icons';

export function ErrorState({ message, onRetry }: { message: string, onRetry?: () => void }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/10 border-l-4 border-red-500 dark:border-red-500/50 p-6 rounded-r-lg my-8 w-full">
      <div className="flex items-start">
        <AlertCircleIcon className="h-6 w-6 text-red-500 dark:text-red-400 mr-3 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-lg font-medium text-red-800 dark:text-red-300">Unable to load feed</h3>
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-500/30 px-4 py-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-red-500 dark:focus-visible:ring-offset-gray-950"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
