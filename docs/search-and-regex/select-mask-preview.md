# Select-mask preview empty state

The Select Mask dialog shows a live preview of the names supplied by the
active panel. When the panel supplies no names, the preview remains visible
and says that no panel names are available. This distinguishes an empty panel
from a valid mask that matched zero names.

The message is informational and does not disable mask validation or the
dialog actions. Once names are available, the normal matching chips and count
return. The message is localized with the dialog's English and Cantonese
strings and uses a status role so assistive technology receives the same
context. Applying a mask keeps the dialog open until its history and selection
preferences finish saving; a persistence failure is reported and the user can
retry instead of receiving a premature success and an unhandled rejection.

Verification: `node --test test/selectmask.test.js`.
