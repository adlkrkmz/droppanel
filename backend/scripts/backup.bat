@echo off
set BACKUP_DIR=C:\Users\pc\Desktop\ebay listing\backups
set TIMESTAMP=%date:~10,4%%date:~7,2%%date:~4,2%_%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
set FILENAME=%BACKUP_DIR%\droppanel_%TIMESTAMP%.sql

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo Backup başlıyor: %FILENAME%
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -d droppanel -f "%FILENAME%"

if %ERRORLEVEL% == 0 (
  echo Backup başarılı: %FILENAME%
) else (
  echo Backup BAŞARISIZ!
)

REM 7 günden eski backupları sil
forfiles /p "%BACKUP_DIR%" /s /m *.sql /d -7 /c "cmd /c del @path" 2>nul
