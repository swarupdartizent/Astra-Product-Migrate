-- Changes after the full extract (all stamped later than any existing row).
SET NOCOUNT ON;
UPDATE dbo.Policy SET Status = 'RENEWED', ModifiedOn = '2026-11-20T08:00:00' WHERE PolicyID IN (2, 14, 33);
INSERT INTO dbo.Claim (ClaimID, ClaimNumber, PolicyID, LossDate, ReportedDate, Status, ReserveAmount, ModifiedOn) VALUES (16, 'CLM-30016', 2, '2026-03-02', '2026-03-05', 'OPEN', 4000.00, '2026-11-20T08:00:00'), (17, 'CLM-30017', 14, '2026-04-11', '2026-04-12', 'OPEN', 2500.00, '2026-11-20T08:00:00');
UPDATE dbo.Invoice SET ModifiedOn = '2026-11-20T08:00:00' WHERE InvoiceID = 5;
GO
