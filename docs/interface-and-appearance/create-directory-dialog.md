# Create-directory dialog

The Create-directory dialog keeps its modal open while the folder operation and
optional permission update run. A successful operation closes the dialog and
refreshes the caller through `onCreated(path)`; a failed operation shows a
notification and leaves the entered name and settings available for retry.

The OK action returns `true` while its asynchronous work is pending, following
the renderer modal contract. This prevents the modal shell from closing before
the filesystem result is known.

Verification: `node --test test/createdirectory.test.js`.
