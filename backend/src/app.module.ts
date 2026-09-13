import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CategoriesModule } from './categories/categories.module';
import { Category } from './categories/entities/category.entity';
import { Organization } from './organizations/entities/organization.entity';
import { OrganizationsModule } from './organizations/organizations.module';
import { Otp } from './otp/entities/otp.entity';
import { OtpModule } from './otp/otp.module';
import { Price } from './prices/entities/price.entity';
import { PricesModule } from './prices/prices.module';
import { Qualification } from './qualifications/entities/qualification.entity';
import { QualificationsModule } from './qualifications/qualifications.module';
import { User } from './user/entities/user.entity';
import { LanguagesModule } from './languages/languages.module';
import { Language } from './languages/entities/language.entity';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'postgres'),
        port: configService.get<number>('DB_PORT') || 5432,
        password: configService.get<string>('DB_PASS', ''),
        username: configService.get<string>('DB_USER', 'postgres'),
        entities: [Organization, Category, Qualification, Price, User, Otp, Language],
        database: configService.get<string>('DB_NAME', 'expert-finder'),
        synchronize: true,
        logging: true,
      }),
    }),
    OrganizationsModule,
    CategoriesModule,
    QualificationsModule,
    PricesModule,
    LanguagesModule,
    UserModule,
    OtpModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
