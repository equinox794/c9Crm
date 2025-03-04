import React from 'react';
import { DayPicker } from 'react-day-picker';

const Calendar = ({ 
    className = '',
    classNames,
    showOutsideDays = true,
    ...props
}) => {
    return (
        <DayPicker
            showOutsideDays={showOutsideDays}
            className={`p-3 ${className}`}
            classNames={{
                months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
                month: 'space-y-4',
                caption: 'flex justify-center pt-1 relative items-center',
                caption_label: 'text-sm font-medium',
                nav: 'space-x-1 flex items-center',
                nav_button: 'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
                nav_button_previous: 'absolute left-1',
                nav_button_next: 'absolute right-1',
                table: 'w-full border-collapse space-y-1',
                head_row: 'flex',
                head_cell: 'text-slate-500 rounded-md w-9 font-normal text-[0.8rem] dark:text-slate-400',
                row: 'flex w-full mt-2',
                cell: 'text-center text-sm p-0 relative [&:has([aria-selected])]:bg-slate-100 first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20 dark:[&:has([aria-selected])]:bg-slate-800',
                day: 'h-9 w-9 p-0 font-normal aria-selected:opacity-100',
                day_selected: 'bg-slate-900 text-slate-50 hover:bg-slate-900 hover:text-slate-50 focus:bg-slate-900 focus:text-slate-50 dark:bg-slate-50 dark:text-slate-900 dark:hover:bg-slate-50 dark:hover:text-slate-900 dark:focus:bg-slate-50 dark:focus:text-slate-900',
                day_today: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-50',
                day_outside: 'text-slate-500 opacity-50 dark:text-slate-400',
                day_disabled: 'text-slate-500 opacity-50 dark:text-slate-400',
                day_range_middle: 'aria-selected:bg-slate-100 aria-selected:text-slate-900 dark:aria-selected:bg-slate-800 dark:aria-selected:text-slate-50',
                day_hidden: 'invisible',
                ...classNames,
            }}
            {...props}
        />
    );
};

export { Calendar }; 