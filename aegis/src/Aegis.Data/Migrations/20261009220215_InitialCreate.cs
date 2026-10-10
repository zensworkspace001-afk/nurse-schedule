using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aegis.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AccessLog",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Ts = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ActorUid = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    ActorEmail = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Action = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    TargetKind = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    TargetId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    FieldsJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Ip = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Ua = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    ExtraJson = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AccessLog", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Announcement",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    Active = table.Column<bool>(type: "bit", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Text = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    UpdatedByUid = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    UpdatedByName = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Announcement", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AppUser",
                columns: table => new
                {
                    Id = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    LoginId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    Email = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    PasswordHash = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    Disabled = table.Column<bool>(type: "bit", nullable: false),
                    IsSuperAdmin = table.Column<bool>(type: "bit", nullable: false),
                    FailedLogins = table.Column<int>(type: "int", nullable: false),
                    LockoutUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    SecurityStamp = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    LastLoginAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AppUser", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ArchiveReport",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    Note = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Csv = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CsvSavedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    BackedUpAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ArchiveReport", x => new { x.Year, x.Month });
                });

            migrationBuilder.CreateTable(
                name: "ExStaff",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    Email = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Level = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true),
                    TenureYears = table.Column<int>(type: "int", nullable: true),
                    Avatar = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    AvatarThumb = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    HadAvatar = table.Column<bool>(type: "bit", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    DeletedByUid = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    DeletedByEmail = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExStaff", x => x.StaffId);
                });

            migrationBuilder.CreateTable(
                name: "LeaveWishEntry",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    FirstSubmittedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    SubmittedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeaveWishEntry", x => new { x.Year, x.Month, x.StaffId });
                });

            migrationBuilder.CreateTable(
                name: "LeaveWishWindow",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    Open = table.Column<bool>(type: "bit", nullable: false),
                    ReqD = table.Column<int>(type: "int", nullable: false),
                    ReqE = table.Column<int>(type: "int", nullable: false),
                    ReqN = table.Column<int>(type: "int", nullable: false),
                    Quota = table.Column<int>(type: "int", nullable: false),
                    DaysPerPerson = table.Column<int>(type: "int", nullable: false),
                    OpenedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ClosedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Version = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeaveWishWindow", x => new { x.Year, x.Month });
                });

            migrationBuilder.CreateTable(
                name: "LegacyHashConfig",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    SignerKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    SaltSeparator = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Rounds = table.Column<int>(type: "int", nullable: false),
                    MemoryCost = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LegacyHashConfig", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LevelBonus",
                columns: table => new
                {
                    Level = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    Amount = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LevelBonus", x => x.Level);
                });

            migrationBuilder.CreateTable(
                name: "MonthlyHealthStat",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    Avg = table.Column<int>(type: "int", nullable: false),
                    Median = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MonthlyHealthStat", x => new { x.Year, x.Month });
                });

            migrationBuilder.CreateTable(
                name: "OneTimeToken",
                columns: table => new
                {
                    TokenHash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Purpose = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OneTimeToken", x => x.TokenHash);
                });

            migrationBuilder.CreateTable(
                name: "PasswordHistory",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Seq = table.Column<int>(type: "int", nullable: false),
                    Salt = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Hash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    At = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PasswordHistory", x => new { x.StaffId, x.Seq });
                });

            migrationBuilder.CreateTable(
                name: "RefreshToken",
                columns: table => new
                {
                    TokenHash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    FamilyId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Persistent = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ReplacedBy = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RefreshToken", x => x.TokenHash);
                });

            migrationBuilder.CreateTable(
                name: "ScheduleCell",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    Kind = table.Column<byte>(type: "tinyint", nullable: false),
                    RowKey = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Day = table.Column<int>(type: "int", nullable: false),
                    ShiftType = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ShiftTime = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScheduleCell", x => new { x.Year, x.Month, x.Kind, x.RowKey, x.Day });
                });

            migrationBuilder.CreateTable(
                name: "ScheduleMonth",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScheduleMonth", x => new { x.Year, x.Month });
                });

            migrationBuilder.CreateTable(
                name: "ShiftOption",
                columns: table => new
                {
                    Code = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Time = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Color = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    SortOrder = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ShiftOption", x => x.Code);
                });

            migrationBuilder.CreateTable(
                name: "Staff",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    Email = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Gender = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Level = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    IsLeader = table.Column<bool>(type: "bit", nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    SpecialStatus = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    LeaveStatus = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    IsPregnantOrNursing = table.Column<bool>(type: "bit", nullable: false),
                    CanNightShift = table.Column<bool>(type: "bit", nullable: false),
                    TenureYears = table.Column<int>(type: "int", nullable: false),
                    AccumulatedOt = table.Column<int>(type: "int", nullable: false),
                    NightShiftBalance = table.Column<int>(type: "int", nullable: false),
                    AnnualLeaveUsed = table.Column<int>(type: "int", nullable: true),
                    ProfileCompleted = table.Column<bool>(type: "bit", nullable: true),
                    ProfileCompletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ProfileUpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    PdpaConsentedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    PdpaNoticeVersion = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    MustChangePassword = table.Column<bool>(type: "bit", nullable: false),
                    IsAdmin = table.Column<bool>(type: "bit", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Staff", x => x.StaffId);
                });

            migrationBuilder.CreateTable(
                name: "WardSettings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    BedCount = table.Column<int>(type: "int", nullable: false),
                    HospitalLevel = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    RatioD = table.Column<int>(type: "int", nullable: false),
                    RatioE = table.Column<int>(type: "int", nullable: false),
                    RatioN = table.Column<int>(type: "int", nullable: false),
                    ReqD = table.Column<int>(type: "int", nullable: false),
                    ReqE = table.Column<int>(type: "int", nullable: false),
                    ReqN = table.Column<int>(type: "int", nullable: false),
                    OptimalD = table.Column<int>(type: "int", nullable: true),
                    OptimalE = table.Column<int>(type: "int", nullable: true),
                    OptimalN = table.Column<int>(type: "int", nullable: true),
                    BaseSalaryCiphertext = table.Column<byte[]>(type: "varbinary(max)", nullable: true),
                    BaseSalaryNonce = table.Column<byte[]>(type: "varbinary(12)", maxLength: 12, nullable: true),
                    BaseSalaryTag = table.Column<byte[]>(type: "varbinary(16)", maxLength: 16, nullable: true),
                    BaseSalaryVersion = table.Column<byte>(type: "tinyint", nullable: true),
                    BaseSalaryKeyId = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true),
                    PublishedYear = table.Column<int>(type: "int", nullable: true),
                    PublishedMonth = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WardSettings", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LeaveWishDay",
                columns: table => new
                {
                    Year = table.Column<int>(type: "int", nullable: false),
                    Month = table.Column<int>(type: "int", nullable: false),
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Day = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeaveWishDay", x => new { x.Year, x.Month, x.StaffId, x.Day });
                    table.ForeignKey(
                        name: "FK_LeaveWishDay_LeaveWishEntry_Year_Month_StaffId",
                        columns: x => new { x.Year, x.Month, x.StaffId },
                        principalTable: "LeaveWishEntry",
                        principalColumns: new[] { "Year", "Month", "StaffId" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SettlementRecord",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Period = table.Column<string>(type: "nvarchar(7)", maxLength: 7, nullable: false),
                    Annual = table.Column<int>(type: "int", nullable: false),
                    Ot = table.Column<int>(type: "int", nullable: false),
                    Night = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SettlementRecord", x => new { x.StaffId, x.Period });
                    table.ForeignKey(
                        name: "FK_SettlementRecord_Staff_StaffId",
                        column: x => x.StaffId,
                        principalTable: "Staff",
                        principalColumn: "StaffId",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "StaffAvatar",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Avatar = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    AvatarThumb = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StaffAvatar", x => x.StaffId);
                    table.ForeignKey(
                        name: "FK_StaffAvatar_Staff_StaffId",
                        column: x => x.StaffId,
                        principalTable: "Staff",
                        principalColumn: "StaffId",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "StaffSensitive",
                columns: table => new
                {
                    StaffId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    IdNumberCiphertext = table.Column<byte[]>(type: "varbinary(max)", nullable: true),
                    IdNumberNonce = table.Column<byte[]>(type: "varbinary(12)", maxLength: 12, nullable: true),
                    IdNumberTag = table.Column<byte[]>(type: "varbinary(16)", maxLength: 16, nullable: true),
                    IdNumberVersion = table.Column<byte>(type: "tinyint", nullable: true),
                    IdNumberKeyId = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true),
                    BankAccountCiphertext = table.Column<byte[]>(type: "varbinary(max)", nullable: true),
                    BankAccountNonce = table.Column<byte[]>(type: "varbinary(12)", maxLength: 12, nullable: true),
                    BankAccountTag = table.Column<byte[]>(type: "varbinary(16)", maxLength: 16, nullable: true),
                    BankAccountVersion = table.Column<byte>(type: "tinyint", nullable: true),
                    BankAccountKeyId = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true),
                    PhoneCiphertext = table.Column<byte[]>(type: "varbinary(max)", nullable: true),
                    PhoneNonce = table.Column<byte[]>(type: "varbinary(12)", maxLength: 12, nullable: true),
                    PhoneTag = table.Column<byte[]>(type: "varbinary(16)", maxLength: 16, nullable: true),
                    PhoneVersion = table.Column<byte>(type: "tinyint", nullable: true),
                    PhoneKeyId = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StaffSensitive", x => x.StaffId);
                    table.ForeignKey(
                        name: "FK_StaffSensitive_Staff_StaffId",
                        column: x => x.StaffId,
                        principalTable: "Staff",
                        principalColumn: "StaffId",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AccessLog_Action_Ts",
                table: "AccessLog",
                columns: new[] { "Action", "Ts" });

            migrationBuilder.CreateIndex(
                name: "IX_AccessLog_Ts",
                table: "AccessLog",
                column: "Ts");

            migrationBuilder.CreateIndex(
                name: "IX_AppUser_LoginId",
                table: "AppUser",
                column: "LoginId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AppUser_StaffId",
                table: "AppUser",
                column: "StaffId");

            migrationBuilder.CreateIndex(
                name: "IX_OneTimeToken_UserId_Purpose",
                table: "OneTimeToken",
                columns: new[] { "UserId", "Purpose" });

            migrationBuilder.CreateIndex(
                name: "IX_RefreshToken_FamilyId",
                table: "RefreshToken",
                column: "FamilyId");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshToken_UserId",
                table: "RefreshToken",
                column: "UserId");

            // 兩個檢視表（對應 Firestore 的 StaffPublic / SchedulesPublic 投影）。
            // 寫死在這裡而不是呼叫 Views.CreateSql：migration 是歷史紀錄，之後改檢視表要另加一個 migration。
            migrationBuilder.Sql("""
                CREATE VIEW vStaffPublic AS
                SELECT s.StaffId, s.Name, s.Level, s.IsLeader, s.IsActive, a.AvatarThumb
                FROM Staff s LEFT JOIN StaffAvatar a ON a.StaffId = s.StaffId
                """);
            migrationBuilder.Sql("""
                CREATE VIEW vSchedulePublic AS
                SELECT c.Year, c.Month, c.RowKey, c.Day,
                       CASE WHEN c.ShiftType IN (N'事假', N'病假', N'特休') THEN 'OFF' ELSE c.ShiftType END AS ShiftType,
                       c.ShiftTime
                FROM ScheduleCell c WHERE c.Kind = 1
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP VIEW IF EXISTS vSchedulePublic");
            migrationBuilder.Sql("DROP VIEW IF EXISTS vStaffPublic");

            migrationBuilder.DropTable(
                name: "AccessLog");

            migrationBuilder.DropTable(
                name: "Announcement");

            migrationBuilder.DropTable(
                name: "AppUser");

            migrationBuilder.DropTable(
                name: "ArchiveReport");

            migrationBuilder.DropTable(
                name: "ExStaff");

            migrationBuilder.DropTable(
                name: "LeaveWishDay");

            migrationBuilder.DropTable(
                name: "LeaveWishWindow");

            migrationBuilder.DropTable(
                name: "LegacyHashConfig");

            migrationBuilder.DropTable(
                name: "LevelBonus");

            migrationBuilder.DropTable(
                name: "MonthlyHealthStat");

            migrationBuilder.DropTable(
                name: "OneTimeToken");

            migrationBuilder.DropTable(
                name: "PasswordHistory");

            migrationBuilder.DropTable(
                name: "RefreshToken");

            migrationBuilder.DropTable(
                name: "ScheduleCell");

            migrationBuilder.DropTable(
                name: "ScheduleMonth");

            migrationBuilder.DropTable(
                name: "SettlementRecord");

            migrationBuilder.DropTable(
                name: "ShiftOption");

            migrationBuilder.DropTable(
                name: "StaffAvatar");

            migrationBuilder.DropTable(
                name: "StaffSensitive");

            migrationBuilder.DropTable(
                name: "WardSettings");

            migrationBuilder.DropTable(
                name: "LeaveWishEntry");

            migrationBuilder.DropTable(
                name: "Staff");
        }
    }
}
