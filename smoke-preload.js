window.addEventListener('error', function(e){ try { require('fs').appendFileSync('tour-err.txt', e.message + ' @ ' + e.filename + ':' + e.lineno + '
'); } catch(err){} }, true);