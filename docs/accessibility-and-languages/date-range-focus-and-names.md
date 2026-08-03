# Date-range picker focus and accessible names

The changelog date-range picker keeps keyboard focus on its active day while
the calendar is repainted. Its grid now also has a real labelledby target: the
localized “from / to” text is present in a screen-reader-only element instead
of an empty layout spacer.

This preserves the compact visual header while giving assistive technology a
stable name for the grid. Escape, the Close button, and clicking outside still
return focus to the control that opened the picker.

Verification: `node --test test/changelog.test.js`.
