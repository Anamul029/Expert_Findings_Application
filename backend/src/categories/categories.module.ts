import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
<<<<<<< HEAD
import { TypeOrmModule } from '@nestjs/typeorm';
=======
>>>>>>> 7d368df0d2a96e4834a10d4fbcad582c7d55c1fa
import { Category } from './entities/category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Category])],
<<<<<<< HEAD
  controllers: [CategoriesController],
=======
  controllers: [CategoryController],
>>>>>>> 7d368df0d2a96e4834a10d4fbcad582c7d55c1fa
  providers: [CategoriesService],
})
export class CategoriesModule {}
