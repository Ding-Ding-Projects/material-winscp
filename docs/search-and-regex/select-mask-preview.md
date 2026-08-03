# Select-mask preview empty state

The Select Mask dialog shows a live preview of the names supplied by the
active panel. When the panel supplies no names, the preview remains visible
and says that no panel names are available. This distinguishes an empty panel
from a valid mask that matched zero names.

The message is informational and does not disable mask validation or the
dialog actions. Once names are available, the normal matching chips and count
return. The message is localized with the dialog's English and Cantonese
strings and uses a status role so assistive technology receives the same
context.

Verification: `node --test test/selectmask.test.js`.
