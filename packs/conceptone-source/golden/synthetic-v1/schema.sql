-- SYNTHETIC golden estate, version 1.
-- This is NOT ConceptOne's real schema, which we have not seen. It is an invented schema shaped after
-- what public material and product experts say a ConceptOne estate holds (fit assessment, 17 Nov 2026):
-- policies with multi-carrier splits, billing and premium finance, commissions, claims, an embedded
-- document store ("File Cabinet"), user-defined tables, validation rules, workflows, security profiles
-- and External Programs. It exists to test the adapter, the domain pack and the platform with known
-- correct answers. Replace or extend it with an anonymised real estate when one is available.

CREATE TABLE dbo.Book (
  BookID int NOT NULL PRIMARY KEY, Code varchar(10) NOT NULL, Name nvarchar(100) NOT NULL,
  ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Carrier (
  CarrierID int NOT NULL PRIMARY KEY, Code varchar(10) NOT NULL, Name nvarchar(100) NOT NULL,
  NAICCode varchar(5) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Entity (
  EntityID int NOT NULL PRIMARY KEY, EntityType char(1) NOT NULL, Name nvarchar(200) NOT NULL,
  TaxID varchar(20) NULL, State char(2) NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Producer (
  ProducerID int NOT NULL PRIMARY KEY, EntityID int NOT NULL REFERENCES dbo.Entity(EntityID),
  LicenseNo varchar(20) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.LineOfBusiness (LOBCode varchar(6) NOT NULL PRIMARY KEY, Name nvarchar(100) NOT NULL)
GO
CREATE TABLE dbo.Policy (
  PolicyID int NOT NULL PRIMARY KEY, PolicyNumber varchar(20) NOT NULL, BookID int NOT NULL REFERENCES dbo.Book(BookID),
  InsuredID int NOT NULL REFERENCES dbo.Entity(EntityID), ProducerID int NOT NULL REFERENCES dbo.Producer(ProducerID),
  LOBCode varchar(6) NOT NULL REFERENCES dbo.LineOfBusiness(LOBCode), State char(2) NOT NULL,
  EffDate date NOT NULL, ExpDate date NOT NULL, WrittenPremium decimal(12,2) NOT NULL,
  BillType char(1) NOT NULL, Status varchar(12) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.CarrierSplit (
  SplitID int NOT NULL PRIMARY KEY, PolicyID int NOT NULL REFERENCES dbo.Policy(PolicyID),
  CarrierID int NOT NULL REFERENCES dbo.Carrier(CarrierID), SharePct decimal(7,4) NOT NULL,
  PremiumShare decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Invoice (
  InvoiceID int NOT NULL PRIMARY KEY, PolicyID int NOT NULL REFERENCES dbo.Policy(PolicyID),
  InvoiceDate date NOT NULL, TotalAmount decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.InvoiceLine (
  LineID int NOT NULL PRIMARY KEY, InvoiceID int NOT NULL REFERENCES dbo.Invoice(InvoiceID),
  LineType varchar(6) NOT NULL, Amount decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Commission (
  CommissionID int NOT NULL PRIMARY KEY, PolicyID int NOT NULL REFERENCES dbo.Policy(PolicyID),
  ProducerID int NOT NULL REFERENCES dbo.Producer(ProducerID), Rate decimal(5,4) NOT NULL,
  Amount decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.CommissionSplit (
  CommSplitID int NOT NULL PRIMARY KEY, CommissionID int NOT NULL REFERENCES dbo.Commission(CommissionID),
  SubProducerID int NOT NULL REFERENCES dbo.Producer(ProducerID), Amount decimal(12,2) NOT NULL,
  ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Claim (
  ClaimID int NOT NULL PRIMARY KEY, ClaimNumber varchar(20) NOT NULL, PolicyID int NOT NULL REFERENCES dbo.Policy(PolicyID),
  LossDate date NOT NULL, ReportedDate date NOT NULL, Status varchar(12) NOT NULL,
  ReserveAmount decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Bordereau (
  BordereauID int NOT NULL PRIMARY KEY, CarrierID int NOT NULL REFERENCES dbo.Carrier(CarrierID),
  Kind char(1) NOT NULL, PeriodEnd date NOT NULL, TotalPremium decimal(14,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.PremiumFinance (
  FinanceID int NOT NULL PRIMARY KEY, PolicyID int NOT NULL REFERENCES dbo.Policy(PolicyID),
  FinanceCoName nvarchar(100) NOT NULL, AmountFinanced decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.FileCabinet (
  DocID int NOT NULL PRIMARY KEY, DocName nvarchar(200) NOT NULL, LinkType char(1) NOT NULL, LinkKey int NOT NULL,
  CreatedOn datetime2 NOT NULL, Content varbinary(max) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.ValidationRule (
  RuleID int NOT NULL PRIMARY KEY, RuleName varchar(60) NOT NULL, TableName varchar(60) NOT NULL,
  Expression nvarchar(400) NOT NULL, Message nvarchar(200) NOT NULL, ModifiedBy varchar(40) NOT NULL,
  ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.WorkflowDefinition (
  WorkflowID int NOT NULL PRIMARY KEY, Name varchar(60) NOT NULL, TriggerEvent varchar(40) NOT NULL,
  IsDesktopOnly bit NOT NULL, ModifiedBy varchar(40) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.WorkflowStep (
  StepID int NOT NULL PRIMARY KEY, WorkflowID int NOT NULL REFERENCES dbo.WorkflowDefinition(WorkflowID),
  Seq int NOT NULL, Action varchar(60) NOT NULL)
GO
CREATE TABLE dbo.SecurityProfile (
  ProfileID int NOT NULL PRIMARY KEY, Name varchar(60) NOT NULL, ModifiedBy varchar(40) NOT NULL,
  ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.SecurityProfileRight (
  ProfileID int NOT NULL REFERENCES dbo.SecurityProfile(ProfileID), RightCode varchar(40) NOT NULL,
  Allowed bit NOT NULL, PRIMARY KEY (ProfileID, RightCode))
GO
CREATE TABLE dbo.ExternalProgram (
  ProgramID int NOT NULL PRIMARY KEY, Name varchar(60) NOT NULL, CommandLine nvarchar(300) NOT NULL,
  TriggerEvent varchar(40) NOT NULL, ConnectsToDatabase bit NOT NULL, Endpoint nvarchar(200) NULL,
  ModifiedBy varchar(40) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.AuditLog (
  AuditID int IDENTITY(1,1) NOT NULL PRIMARY KEY, TableName varchar(60) NOT NULL, RecordKey int NOT NULL,
  Action varchar(10) NOT NULL, LoggedOn datetime2 NOT NULL)
GO

-- User-defined tables (customer extensions). One has no primary key: a known trap.
CREATE TABLE dbo.usr_InspectionNotes (
  NoteID int NOT NULL PRIMARY KEY, PolicyID int NOT NULL, Note nvarchar(400) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.usr_CarrierCodes (CarrierID int NOT NULL, ExternalCode varchar(20) NOT NULL)
GO
CREATE TABLE dbo.usr_RenewalFlags (PolicyID int NOT NULL PRIMARY KEY, Flag varchar(20) NOT NULL)
GO

CREATE VIEW dbo.vw_PolicySummary AS
  SELECT p.PolicyID, p.PolicyNumber, e.Name AS InsuredName, p.EffDate, p.ExpDate, p.WrittenPremium
  FROM dbo.Policy p JOIN dbo.Entity e ON e.EntityID = p.InsuredID
GO
CREATE VIEW dbo.vw_BordereauPremium AS
  SELECT s.CarrierID, SUM(s.PremiumShare) AS Premium FROM dbo.CarrierSplit s GROUP BY s.CarrierID
GO

CREATE FUNCTION dbo.fn_PolicyTermDays (@PolicyID int) RETURNS int AS
BEGIN
  RETURN (SELECT DATEDIFF(day, EffDate, ExpDate) FROM dbo.Policy WHERE PolicyID = @PolicyID)
END
GO

-- Commission is calculated in code, not configuration: a business rule the target must re-create.
CREATE PROCEDURE dbo.usp_CalcCommission @PolicyID int AS
BEGIN
  SET NOCOUNT ON;
  UPDATE c SET Amount = ROUND(p.WrittenPremium * c.Rate, 2), ModifiedOn = SYSUTCDATETIME()
  FROM dbo.Commission c JOIN dbo.Policy p ON p.PolicyID = c.PolicyID WHERE c.PolicyID = @PolicyID;
END
GO
-- Sends bordereau premium to a reporting warehouse over a linked server: an interface nobody documented.
CREATE PROCEDURE dbo.usp_BordereauExtract @PeriodEnd date AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @sql nvarchar(max) = N'INSERT INTO WAREHOUSE.dw.dbo.Premium (CarrierID, Premium, PeriodEnd) '
    + N'SELECT CarrierID, Premium, @p FROM dbo.vw_BordereauPremium';
  EXEC sp_executesql @sql, N'@p date', @p = @PeriodEnd;
END
GO
CREATE PROCEDURE dbo.usp_PostPayment @InvoiceID int, @Amount decimal(12,2) AS
BEGIN
  SET NOCOUNT ON;
  INSERT INTO dbo.AuditLog (TableName, RecordKey, Action, LoggedOn)
  SELECT 'Invoice', i.InvoiceID, 'PAY', SYSUTCDATETIME() FROM dbo.Invoice i WHERE i.InvoiceID = @InvoiceID;
END
GO

-- Hidden rule: a policy with open claims cannot be cancelled. Enforced only in this trigger.
CREATE TRIGGER dbo.trg_Policy_StatusGuard ON dbo.Policy AFTER UPDATE AS
BEGIN
  IF EXISTS (SELECT 1 FROM inserted i JOIN dbo.Claim c ON c.PolicyID = i.PolicyID
             WHERE i.Status = 'CANCELLED' AND c.Status = 'OPEN')
  BEGIN
    RAISERROR ('A policy with open claims cannot be cancelled.', 16, 1);
    ROLLBACK TRANSACTION;
  END
END
GO
-- Hidden rule: claim reserves can never be negative.
CREATE TRIGGER dbo.trg_Claim_ReserveGuard ON dbo.Claim AFTER INSERT, UPDATE AS
BEGIN
  IF EXISTS (SELECT 1 FROM inserted WHERE ReserveAmount < 0)
    THROW 50001, 'Claim reserve cannot be negative.', 1;
END
GO
-- Audit side effect only; not a business rule.
CREATE TRIGGER dbo.trg_Invoice_Audit ON dbo.Invoice AFTER INSERT, UPDATE AS
BEGIN
  INSERT INTO dbo.AuditLog (TableName, RecordKey, Action, LoggedOn)
  SELECT 'Invoice', InvoiceID, 'WRITE', SYSUTCDATETIME() FROM inserted;
END
GO
