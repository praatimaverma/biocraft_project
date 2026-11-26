# Removes the two BioCraft Tally sync tasks (run as Administrator).
foreach ($n in 'BiocraftTallySync-Morning-0800IST', 'BiocraftTallySync-Evening-1500IST') {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $n -Confirm:$false; Write-Host "Removed $n" }
}
